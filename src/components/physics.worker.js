import { lerp } from '../helpers'
import AmmoJS from "../ammo/ammo.wasm.es.js"

// Firefox limitation: https://github.com/vitejs/vite/issues/4586

// there's probably a better place for these variables
let bodies = []
let sleepingBodies = []
let colliders = {}
let physicsWorld
let Ammo
let worldWorkerPort
let tmpBtTrans
let sharedVector3
let width = 150
let height = 150
let aspect = 1
let stopLoop = false

// face-data cache for forced-roll search infrastructure. populated by rendering worker
// after each theme loads via the "loadFaceData" message. keyed by `${meshName}_${dieType}`.
// each entry: { faceNormals: Float32Array (3 floats per face), faceMap: {faceId: value},
// d4FaceDown: bool }. used in evaluateFace() to determine which face is up after a search
// simulation, without needing a Babylon scene.
const faceData = {}
let searchIndex = 0

// collision-filtering: each broadcast unit (collection) gets a unique slot bit; dice in the
// same collection share a slot (so they collide with each other, matching simulateOnceN's
// shared-search-world physics) but ignore dice from other collections (so concurrent rolls
// from different players don't perturb each other's seeded trajectories). bit 0 = walls.
// 15 slot bits covers 4-8 player tables with margin; on exhaustion we fall back to a
// promiscuous slot that collides with everything — restoring pre-fix behavior for the
// overflow only. cross-client coherence is preserved per-client because the property
// "collides with walls only + own collection" is identical regardless of slot bit value.
const GROUP_WALL = 0x0001
const MASK_WALL  = 0xFFFF
const SEARCH_SLOT = 1 << 15  // fixed bit for search worlds (separate Ammo world, no overlap)
const PROMISCUOUS = 0xFFFE   // all dice bits ORed; mask=0xFFFF
const SLOT_BITS = []
for (let i = 1; i <= 15; i++) SLOT_BITS.push(1 << i)

const slotPool = {
	free: SLOT_BITS.slice(),
	used: new Map(), // collectionId -> { slot, refCount, promiscuous }
	acquire(key) {
		if (key === undefined || key === null) key = '__legacy__'
		const existing = this.used.get(key)
		if (existing) { existing.refCount++; return existing.slot }
		if (this.free.length === 0) {
			console.warn('[dice-box] slot pool exhausted (>15 concurrent collections); collection', key,
				'falling back to promiscuous slot — seeded rolls from this collection may diverge across clients')
			this.used.set(key, { slot: PROMISCUOUS, refCount: 1, promiscuous: true })
			return PROMISCUOUS
		}
		const slot = this.free.pop()
		this.used.set(key, { slot, refCount: 1, promiscuous: false })
		return slot
	},
	release(key) {
		if (key === undefined || key === null) key = '__legacy__'
		const entry = this.used.get(key)
		if (!entry) return
		if (--entry.refCount > 0) return
		if (!entry.promiscuous) this.free.push(entry.slot)
		this.used.delete(key)
	},
	resetAll() {
		this.free = SLOT_BITS.slice()
		this.used.clear()
	},
}

const maskForSlot = (slot) => (slot === PROMISCUOUS) ? 0xFFFF : (GROUP_WALL | slot)

const defaultOptions = {
	size: 9.5,
	startingHeight: 8,
	spinForce: 6,
	throwForce: 5,
	gravity: 1,
	mass: 1,
	friction: .8,
	restitution: .1,
	linearDamping: .5,
	angularDamping: .4,
	settleTimeout: 5000,
	// TODO: toss: "center", "edge", "allEdges"
}

let config = {...defaultOptions}

let emptyVector
let diceBufferView
// reused across the hot collision-detection loop in update(); the original code allocated
// a fresh btVector3 per contact-point per frame and never destroyed it — at 60fps with
// ~30 contacts/frame, OOMs Ammo's wasm heap inside ~5 minutes of sustained rolling
let relativeVelocityScratch

self.onmessage = (e) => {
  switch (e.data.action) {
    case "rollDie":
      rollDie(e.data.sides)
      break;
    case "init":
      init(e.data).then(()=>{
        self.postMessage({
          action:"init-complete"
        })
      })
      break
    case "clearDice":
			clearDice()
      break
		case "removeDie":
			removeDie(e.data.id)
			break;
		case "resize":
			width = e.data.width
			height = e.data.height
			// aspect remains locked at 1.0 — see init() comment for determinism rationale
			addBoxToWorld(config.size, config.startingHeight + 10)
			break
		case "updateConfig":
			updateConfig(e.data.options)
			break
    case "connect":
      worldWorkerPort = e.ports[0]
      worldWorkerPort.onmessage = (e) => {
        switch (e.data.action) {
					case "initBuffer":
						diceBufferView = new Float32Array(e.data.diceBuffer)
						diceBufferView[0] = -1
						break;
					case "loadModels":
						// console.log('e.data', e.data)
						loadModels(e.data.options)
						break;
          case "addDie": {
						// when a seed is supplied, skip random start-position rolling — the seed has
						// the exact pose to reproduce. otherwise the existing random-throw path runs.
						const opts = e.data.options
						if (!opts.seed && opts.newStartPoint) {
							setStartPosition()
						}
						const newDie = addDie(opts)
						rollDie(newDie, opts.seed)
            break;
					}
          case "rollDie":
						// TODO: this won't work, need a die object
            rollDie(e.data.id)
            break;
					case "removeDie":
						removeDie(e.data.id)
						break;
          case "stopSimulation":
            stopLoop = true
						
            break;
          case "resumeSimulation":
						if(e.data.newStartPoint){
							setStartPosition()
						}
            stopLoop = false
						loop()
            break;
					case "stepSimulation":
						diceBufferView = new Float32Array(e.data.diceBuffer)
						loop()
						break;
					case "loadFaceData":
						// rendering worker sends face normals + faceId-to-value map per die type
						// after a theme loads. these let us evaluate which face is up after a
						// search simulation without needing a Babylon scene.
						faceData[e.data.key] = {
							faceNormals: new Float32Array(e.data.faceNormals),
							faceMap: e.data.faceMap,
							d4FaceDown: e.data.d4FaceDown,
							dieType: e.data.dieType,
						}
						break
					case "searchSeed":
						// sequential rejection sampling. runs invisibly to find a seed (initial
						// position/velocity/angularVelocity/rotation) that lands the die on the
						// requested face value. result posted back via "searchResult".
						// pair: true → d100 split-search (d100 + inner d10 in same search world)
						// multi: true → N-dice search (e.g. 2d20 advantage, with both bodies
						// throwing in same world to keep collision dynamics consistent with
						// the visible playback)
						if (e.data.multi) doMultiSearch(e.data)
						else if (e.data.pair) doPairSearch(e.data)
						else doSearch(e.data)
						break
          default:
            console.error("action not found in physics worker from worldOffscreen worker:", e.data.action)
        }
      }
      break
    default:
      console.error("action not found in physics worker:", e.data.action)
  }
}


const computeGravity = (gravity = defaultOptions.gravity, mass = defaultOptions.mass) => {
	// make gravity a little bit stronger for heavy objects, so they seem heavier
	return gravity === 0 ? 0 : gravity + mass / 3
}

const computeMass = (mass = defaultOptions.mass) => {
	// high values in mass are pretty ineffective, but whole intigers make better config values, so we shave down the value
	// also prevents mass from ever being zero
	return 1 + mass / 3
}

const computeSpin = (spin = defaultOptions.spinForce, spinScale = 40) => {
	// scale down the actual spin value from a nice intiger in config to a fractional value
	return spin/spinScale
}

const computeThrowForce = (throwForce = defaultOptions.throwForce, mass = defaultOptions.mass, scale = defaultOptions.scale) => {
	return throwForce / 2 / mass * (1 + scale / 6)
}

const computeStartingHeight = (height = defaultOptions.startingHeight) => {
	// ensure minimum startingHeight of 1
	return height < 1 ? 1 : height
}



// runs when the worker loads to set up the Ammo physics world and load our colliders
// loaded colliders will be cached and added to the world in a later post message
const init = async (data) => {
	width = data.width
	height = data.height
	// Physics aspect locked to 1.0 for deterministic seed replay across clients.
	// Different canvas dimensions per client would otherwise produce different physics
	// wall geometry, causing identical seeds to diverge during multi-bounce. Dice cluster
	// centrally rather than spreading to canvas edges — acceptable trade-off for
	// synchronized cross-client physics.
	aspect = 1

	config = {...config,...data.options}
	config.gravity = computeGravity(config.gravity, config.mass)
	config.mass = computeMass(config.mass)
	config.spinForce = computeSpin(config.spinForce)
	config.throwForce = computeThrowForce(config.throwForce,config.mass,config.scale)
	config.startingHeight = computeStartingHeight(config.startingHeight)

	const ammoWASM = {
		// locateFile: () => '../../node_modules/ammo.js/builds/ammo.wasm.wasm'
		locateFile: () => `${config.origin + config.assetPath}ammo/ammo.wasm.wasm`
	}

	Ammo = await new AmmoJS(ammoWASM)

	tmpBtTrans = new Ammo.btTransform()
	sharedVector3 = new Ammo.btVector3(0, 0, 0)
	emptyVector = setVector3(0,0,0)
	relativeVelocityScratch = new Ammo.btVector3(0, 0, 0)

	setStartPosition()

	physicsWorld = setupPhysicsWorld()

	addBoxToWorld(config.size, config.startingHeight + 10)
}

const updateConfig = (options) => {
	config = {...config, ...options}
	if(options.mass){
		config.mass = computeMass(config.mass)
	}
	if(options.mass || options.gravity) {
		config.gravity = computeGravity(config.gravity, config.mass)
	}
	
	if(options.spinForce) {
		config.spinForce = computeSpin(config.spinForce)
	}
	if(options.throwForce || options.mass || options.scale){
		config.throwForce = computeThrowForce(config.throwForce, config.mass, config.scale)
	}
	if(options.startingHeight) {
		computeStartingHeight(config.startingHeight)
	}

	removeBoxFromWorld()
	addBoxToWorld(config.size, config.startingHeight + 10)
	physicsWorld.setGravity(setVector3(0, -9.81 * config.gravity, 0))
	Object.values(colliders).map((collider) => {
		collider.convexHull.setLocalScaling(setVector3(collider.scaling[0] * config.scale, collider.scaling[1] * config.scale, collider.scaling[2] * config.scale))
	})
}

// options object with colliders and meshName are required
const loadModels = async ({colliders: modelData, meshName}) => {

	let has_d100 = false
	let has_d10 = false

	// turn our model data into convex hull items for the physics world
	modelData.forEach((model,i) => {
		colliders[meshName + '_' + model.name] = model
		colliders[meshName + '_' + model.name].convexHull = createConvexHull(model)
		if (!has_d10) {
			has_d10 = model.id === "d10_collider"
		}
		if (!has_d100) {
			has_d100 = model.id === "d100_collider"
		}
	})
	if (!has_d100 && has_d10) {
		colliders[`${meshName}_d100_collider`] = colliders[`${meshName}_d10_collider`]
	}
}

const setVector3 = (x,y,z) => {
	sharedVector3.setValue(x,y,z)
	return sharedVector3
}

const setStartPosition = () => {
	let size = config.size
	// let envelopeSize = size * .6 / 2
	let edgeOffset = .5
	let xMin = size * aspect / 2 - edgeOffset
	let xMax = size * aspect / -2 + edgeOffset
	let yMin = size / 2 - edgeOffset
	let yMax = size / -2 + edgeOffset
	// let xEnvelope = lerp(envelopeSize * aspect - edgeOffset * aspect, -envelopeSize * aspect + edgeOffset * aspect, Math.random())
	let xEnvelope = lerp(xMin, xMax, Math.random())
	let yEnvelope = lerp(yMin, yMax, Math.random())
	let tossFromTop = Math.round(Math.random())
	let tossFromLeft = Math.round(Math.random())
	let tossX = Math.round(Math.random())
	// console.log(`throw coming from`, tossX ? tossFromTop ? "top" : "bottom" : tossFromLeft ? "left" : "right")

	// forces = {
	// 	xMinForce: tossX ? -config.throwForce * aspect : tossFromLeft ? config.throwForce * aspect * .3 : -config.throwForce * aspect * .3,
	// 	xMaxForce: tossX ? config.throwForce * aspect : tossFromLeft ? config.throwForce * aspect * 1 : -config.throwForce * aspect * 1,
	// 	zMinForce: tossX ? tossFromTop ? config.throwForce * .3 : -config.throwForce * .3 : -config.throwForce,
	// 	zMaxForce: tossX ? tossFromTop ? config.throwForce * 1 : -config.throwForce * 1 : config.throwForce,
	// }

	config.startPosition = [
		// tossing on x axis then z should be locked to top or bottom
		// not tossing on x axis then x should be locked to the left or right
		tossX ? xEnvelope : tossFromLeft ? xMax : xMin,
		config.startingHeight,
		tossX ? tossFromTop ? yMax : yMin : yEnvelope
	]

	// console.log(`startPosition`, config.startPosition)
}

const createConvexHull = (mesh) => {
	const convexMesh = new Ammo.btConvexHullShape()

	let count = mesh.positions.length

	for (let i = 0; i < count; i+=3) {
		let v = setVector3(mesh.positions[i], mesh.positions[i+1], mesh.positions[i+2])
		convexMesh.addPoint(v, true)
	}
	
	convexMesh.setLocalScaling(setVector3(mesh.scaling[0] * config.scale, mesh.scaling[1] * config.scale, mesh.scaling[2] * config.scale))

	return convexMesh
}

const createRigidBody = (collisionShape, params) => {
	// apply params
	const {
		mass = .1,
		collisionFlags = 0,
		// pos = { x: 0, y: 0, z: 0 },
		// quat = { x: 0, y: 0, z: 0, w: 1 }
		pos = [0,0,0],
		// quat = [0,0,0,-1],
		quat = [
			lerp(-1.5, 1.5, Math.random()),
			lerp(-1.5, 1.5, Math.random()),
			lerp(-1.5, 1.5, Math.random()),
			-1
		],
		scale = [1,1,1],
		friction = config.friction,
		restitution = config.restitution
	} = params

	// apply position and rotation
	const transform = new Ammo.btTransform()
	// console.log(`collisionShape scaling `, collisionShape.getLocalScaling().x(),collisionShape.getLocalScaling().y(),collisionShape.getLocalScaling().z())
	transform.setIdentity()
	transform.setOrigin(setVector3(pos[0], pos[1], pos[2]))
	// hold the quaternion in a local so it can be destroyed alongside the body — without
	// retaining the reference setRotation copies the value but the original allocation
	// leaks each time createRigidBody runs (search-attempt hot path)
	const btQuat = new Ammo.btQuaternion(quat[0], quat[1], quat[2], quat[3])
	transform.setRotation(btQuat)
	// collisionShape.setLocalScaling(new Ammo.btVector3(1.1, -1.1, 1.1))
	// transform.ScalingToRef()
	// set the scale of the collider
	// collisionShape.setLocalScaling(new Ammo.btVector3(scale[0],scale[1],scale[2]))

	// create the rigid body
	const motionState = new Ammo.btDefaultMotionState(transform)
	const localInertia = setVector3(0, 0, 0)
	if (mass > 0) collisionShape.calculateLocalInertia(mass, localInertia)
	const rbInfo = new Ammo.btRigidBodyConstructionInfo(
		mass,
		motionState,
		collisionShape,
		localInertia
	)
	const rigidBody = new Ammo.btRigidBody(rbInfo)

	// attach auxiliaries so destroyBody() below can reclaim the full chain. Without this,
	// a long soak (200 rolls × ~50 search attempts/roll) leaks ~280 bytes/body and OOMs
	// Ammo's wasm heap inside ~5 minutes. localInertia is the shared sharedVector3 so
	// not a leak source.
	rigidBody.aux = { transform, motionState, rbInfo, btQuat }

	// rigid body properties
	if (mass > 0) rigidBody.setActivationState(4) // Disable deactivation
	rigidBody.setCollisionFlags(collisionFlags)
	rigidBody.setFriction(friction)
	rigidBody.setRestitution(restitution)
	rigidBody.setDamping(config.linearDamping, config.angularDamping)

	// ad rigid body to physics world
	// physicsWorld.addRigidBody(rigidBody)

	return rigidBody

}

// destroy a body created via createRigidBody, reclaiming all chained Ammo allocations.
// must be called AFTER physicsWorld.removeRigidBody() — destroying a body still in the
// world will crash the physics step on the next tick.
const destroyBody = (body) => {
	if (body.aux) {
		Ammo.destroy(body.aux.rbInfo)
		Ammo.destroy(body.aux.motionState)
		Ammo.destroy(body.aux.transform)
		Ammo.destroy(body.aux.btQuat)
	}
	Ammo.destroy(body)
}
// cache for box parts + their construction auxiliaries so resize (which calls
// removeBoxFromWorld then rebuilds) can fully reclaim wasm allocations. Without aux
// tracking, every window-resize leaks 6 walls × (transform + shape + motionState + rbInfo).
let boxParts = []
let boxPartsAux = []
const addBoxToWorld = (size, height) => {
	const tempParts = []
	const tempAux = []
	// ground
	const localInertia = setVector3(0, 0, 0);

	const groundTransform = new Ammo.btTransform()
	groundTransform.setIdentity()
	groundTransform.setOrigin(setVector3(0, -.5, 0))
	const groundShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const groundMotionState = new Ammo.btDefaultMotionState(groundTransform)
	const groundInfo = new Ammo.btRigidBodyConstructionInfo(0, groundMotionState, groundShape, localInertia)
	const groundBody = new Ammo.btRigidBody(groundInfo)
	groundBody.id='box_bottom'
	groundBody.setFriction(config.friction)
	groundBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(groundBody, GROUP_WALL, MASK_WALL)
	tempParts.push(groundBody)
	tempAux.push({ transform: groundTransform, shape: groundShape, motionState: groundMotionState, rbInfo: groundInfo })

	const ceilingTransform = new Ammo.btTransform()
	ceilingTransform.setIdentity()
	ceilingTransform.setOrigin(setVector3(0, height - .5, 0))
	const ceilingShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const ceilingMotionState = new Ammo.btDefaultMotionState(ceilingTransform)
	const ceilingInfo = new Ammo.btRigidBodyConstructionInfo(0, ceilingMotionState, ceilingShape, localInertia)
	const ceilingBody = new Ammo.btRigidBody(ceilingInfo)
	ceilingBody.id='box_top'
	ceilingBody.setFriction(config.friction)
	ceilingBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(ceilingBody, GROUP_WALL, MASK_WALL)
	tempParts.push(ceilingBody)
	tempAux.push({ transform: ceilingTransform, shape: ceilingShape, motionState: ceilingMotionState, rbInfo: ceilingInfo })

	const wallTopTransform = new Ammo.btTransform()
	wallTopTransform.setIdentity()
	wallTopTransform.setOrigin(setVector3(0, 0, (size/-2) - .5))
	const wallTopShape = new Ammo.btBoxShape(setVector3(size * aspect, height, 1))
	const topMotionState = new Ammo.btDefaultMotionState(wallTopTransform)
	const topInfo = new Ammo.btRigidBodyConstructionInfo(0, topMotionState, wallTopShape, localInertia)
	const topBody = new Ammo.btRigidBody(topInfo)
	topBody.id='box_wall_north'
	topBody.setFriction(config.friction)
	topBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(topBody, GROUP_WALL, MASK_WALL)
	tempParts.push(topBody)
	tempAux.push({ transform: wallTopTransform, shape: wallTopShape, motionState: topMotionState, rbInfo: topInfo })

	const wallBottomTransform = new Ammo.btTransform()
	wallBottomTransform.setIdentity()
	wallBottomTransform.setOrigin(setVector3(0, 0, (size/2) + .5))
	const wallBottomShape = new Ammo.btBoxShape(setVector3(size * aspect, height, 1))
	const bottomMotionState = new Ammo.btDefaultMotionState(wallBottomTransform)
	const bottomInfo = new Ammo.btRigidBodyConstructionInfo(0, bottomMotionState, wallBottomShape, localInertia)
	const bottomBody = new Ammo.btRigidBody(bottomInfo)
	bottomBody.id='box_wall_south'
	bottomBody.setFriction(config.friction)
	bottomBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(bottomBody, GROUP_WALL, MASK_WALL)
	tempParts.push(bottomBody)
	tempAux.push({ transform: wallBottomTransform, shape: wallBottomShape, motionState: bottomMotionState, rbInfo: bottomInfo })

	const wallRightTransform = new Ammo.btTransform()
	wallRightTransform.setIdentity()
	wallRightTransform.setOrigin(setVector3((size * aspect / -2) - .5, 0, 0))
	const wallRightShape = new Ammo.btBoxShape(setVector3(1, height, size))
	const rightMotionState = new Ammo.btDefaultMotionState(wallRightTransform)
	const rightInfo = new Ammo.btRigidBodyConstructionInfo(0, rightMotionState, wallRightShape, localInertia)
	const rightBody = new Ammo.btRigidBody(rightInfo)
	rightBody.id='box_wall_east'
	rightBody.setFriction(config.friction)
	rightBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(rightBody, GROUP_WALL, MASK_WALL)
	tempParts.push(rightBody)
	tempAux.push({ transform: wallRightTransform, shape: wallRightShape, motionState: rightMotionState, rbInfo: rightInfo })

	const wallLeftTransform = new Ammo.btTransform()
	wallLeftTransform.setIdentity()
	wallLeftTransform.setOrigin(setVector3((size * aspect / 2) + .5, 0, 0))
	const wallLeftShape = new Ammo.btBoxShape(setVector3(1, height, size))
	const leftMotionState = new Ammo.btDefaultMotionState(wallLeftTransform)
	const leftInfo = new Ammo.btRigidBodyConstructionInfo(0, leftMotionState, wallLeftShape, localInertia)
	const leftBody = new Ammo.btRigidBody(leftInfo)
	leftBody.id='box_wall_west'
	leftBody.setFriction(config.friction)
	leftBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(leftBody, GROUP_WALL, MASK_WALL)
	tempParts.push(leftBody)
	tempAux.push({ transform: wallLeftTransform, shape: wallLeftShape, motionState: leftMotionState, rbInfo: leftInfo })

	if(boxParts.length){
		removeBoxFromWorld()
	}
	boxParts = [...tempParts]
	boxPartsAux = [...tempAux]
}

const removeBoxFromWorld = () => {
	for (let i = 0; i < boxParts.length; i++) {
		physicsWorld.removeRigidBody(boxParts[i])
		Ammo.destroy(boxParts[i])
		const a = boxPartsAux[i]
		Ammo.destroy(a.rbInfo)
		Ammo.destroy(a.motionState)
		Ammo.destroy(a.transform)
		Ammo.destroy(a.shape)
	}
	boxParts = []
	boxPartsAux = []
}

const addDie = (options) => {
	const { sides, id, meshName, scale, seed, collectionId } = options
	const dieType = Number.isInteger(sides) ? `d${sides}` : sides
	let cType = `${dieType}_collider`
	const comboKey = `${meshName}_${cType}`
	const colliderMass = colliders[comboKey]?.physicsMass || .1
	const mass = colliderMass * config.mass * config.scale
	// when a seed is supplied, use its initial pose verbatim so visible playback reproduces
	// the search-found trajectory exactly. otherwise the production random-pose path runs.
	const params = {
		mass,
		scaling: colliders[comboKey].scaling,
		pos: seed ? seed.startPos : config.startPosition,
	}
	if (seed && seed.rotation) {
		params.quat = seed.rotation
	}
	const newDie = createRigidBody(colliders[comboKey].convexHull, params)
	newDie.id = id
	newDie.timeout = config.settleTimeout
	newDie.mass = mass
	// per-collection slot: dice from the same broadcast cluster (matching searchMultiSeed's
	// shared search world); cross-collection dice ghost through each other so concurrent
	// rolls don't perturb seeded trajectories
	const slot = slotPool.acquire(collectionId)
	newDie.collectionKey = (collectionId === undefined || collectionId === null) ? '__legacy__' : collectionId
	physicsWorld.addRigidBody(newDie, slot, maskForSlot(slot))
	bodies.push(newDie)

	return newDie
}

// roll the die. no seed = existing random throw envelope. with seed = replay the exact
// linear velocity + angular impulse that produced the search match, so the visible roll
// lands on the same face the invisible search did.
const rollDie = (die, seed) => {
	if (seed) {
		die.setLinearVelocity(setVector3(seed.linearVel[0], seed.linearVel[1], seed.linearVel[2]))
		const force = new Ammo.btVector3(seed.angularImpulse[0], seed.angularImpulse[1], seed.angularImpulse[2])
		const scale = Math.abs(config.scale - 1) + config.scale * config.scale * (die.mass/config.mass) * .75
		die.applyImpulse(force, setVector3(scale, scale, scale))
		Ammo.destroy(force)
		return
	}

	// random throw — existing behavior
	die.setLinearVelocity(setVector3(
		lerp(-config.startPosition[0] * .5, -config.startPosition[0] * config.throwForce, Math.random()),
		lerp(-config.startPosition[1], -config.startPosition[1] * 2, Math.random()), // limit the y force to 2
		lerp(-config.startPosition[2] * .5, -config.startPosition[2] * config.throwForce, Math.random()),
	))

	const flippy = Math.random() > .5 ? 1 : -1 // random positive or negative number
	const spinny = lerp(config.spinForce * .5, config.spinForce, Math.random())
	const force = new Ammo.btVector3(
		spinny * flippy,
		spinny * -flippy, // flip the flippy to avoid gimble lock
		spinny * flippy
	)

	const scale = Math.abs(config.scale - 1) + config.scale * config.scale * (die.mass/config.mass) * .75
	die.applyImpulse(force, setVector3(scale, scale, scale))
}

const removeDie = (id) => {
	sleepingBodies = sleepingBodies.filter((die) => {
		let match = die.id === id
		if(match){
			slotPool.release(die.collectionKey)
			// remove the mesh from the scene + reclaim wasm allocation. Without Ammo.destroy
			// the btRigidBody + chained motionState/transform leak forever; ~5 min of soak
			// rolling OOMs Ammo's 16MB heap. Auxiliaries created inside createRigidBody
			// (motionState, btTransform, btQuaternion) aren't exposed so still partial-leak
			// (~280 bytes/body) — sufficient for sessions but a future cleanup target.
			physicsWorld.removeRigidBody(die)
			destroyBody(die)
		}
		return !match
	})
	// also handle the rare case where remove fires before the die settles — bodies array
	// is the in-flight set; same release semantics
	bodies = bodies.filter((die) => {
		let match = die.id === id
		if (match) {
			slotPool.release(die.collectionKey)
			physicsWorld.removeRigidBody(die)
			destroyBody(die)
		}
		return !match
	})

	// step the animation forward
	// requestAnimationFrame(loop)
}

const clearDice = () => {
	if(diceBufferView.byteLength){
		diceBufferView.fill(0)
	}
	stopLoop = true
	// clear all bodies + reclaim wasm allocation (see removeDie note on destroyBody)
	bodies.forEach(body => { physicsWorld.removeRigidBody(body); destroyBody(body) })
	sleepingBodies.forEach(body => { physicsWorld.removeRigidBody(body); destroyBody(body) })
	// clear cache arrays
	bodies = []
	sleepingBodies = []
	// reset all in-flight slot allocations — every die is gone, no refcount tracking needed
	slotPool.resetAll()
}


const setupPhysicsWorld = () => {
	const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration()
	const broadphase = new Ammo.btDbvtBroadphase()
	const solver = new Ammo.btSequentialImpulseConstraintSolver()
	const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration)
	const World = new Ammo.btDiscreteDynamicsWorld(
		dispatcher,
		broadphase,
		solver,
		collisionConfiguration
	)
	World.setGravity(setVector3(0, -9.81 * config.gravity, 0))

	return World
}

const update = (delta) => {
	// step world
	const deltaTime = delta / 1000
	
	// console.time("stepSimulation")
	physicsWorld.stepSimulation(deltaTime, 2, 1 / 90) // higher number = slow motion
	// console.timeEnd("stepSimulation")

	diceBufferView[0] = bodies.length

	// Detect collisions
    const numManifolds = physicsWorld.getDispatcher().getNumManifolds();
    for (let i = 0; i < numManifolds; i++) {
        const contactManifold = physicsWorld.getDispatcher().getManifoldByIndexInternal(i);
        const body0 = Ammo.castObject(contactManifold.getBody0(), Ammo.btRigidBody);
        const body1 = Ammo.castObject(contactManifold.getBody1(), Ammo.btRigidBody);

        const rb0Id = body0.id;
        const rb1Id = body1.id;

        let totalForce = 0;

        // Calculate collision force
        const numContacts = contactManifold.getNumContacts();
        for (let j = 0; j < numContacts; j++) {
            const contactPoint = contactManifold.getContactPoint(j);

            // Check if the contact point indicates collision (penetration depth)
            if (contactPoint.getDistance() < 0) {
                // Relative velocity of the two bodies at the contact point
                const normal = contactPoint.get_m_normalWorldOnB();

                const velocity0 = body0.getLinearVelocity();
                const velocity1 = body1.getLinearVelocity();

                // reuse module-scope scratch — see top-of-file note. Allocating fresh here
                // (the original code) leaks a btVector3 per contact-point per frame.
                relativeVelocityScratch.setValue(
                    velocity0.x() - velocity1.x(),
                    velocity0.y() - velocity1.y(),
                    velocity0.z() - velocity1.z()
                );

                // Calculate the force (F = m * a) based on velocity and collision normal
                const collisionForce = normal.dot(relativeVelocityScratch);
                totalForce += Math.abs(collisionForce);  // Add to total collision force
							}
						}
						
        if (totalForce > 0) {
            // Send the collision data to the main thread
            self.postMessage({
                action: "collision",
                body0Id: rb0Id,
                body1Id: rb1Id,
                force: totalForce
            });
        }
    }

	// looping backwards since bodies are removed as they are put to sleep
	for (let i = bodies.length - 1; i >= 0; i--) {
		const rb = bodies[i]
		const speed = rb.getLinearVelocity().length()
		const tilt = rb.getAngularVelocity().length()

		if(speed < .01 && tilt < .005 || rb.timeout < 0) {
			// flag the second param for this body so it can be processed in World, first param will be the roll.id
			diceBufferView[(i*8) + 1] = rb.id
			diceBufferView[(i*8) + 2] = -1
			rb.asleep = true
			rb.setMassProps(0)
			rb.forceActivationState(3)
			// zero out anything left
			rb.setLinearVelocity(emptyVector)
			rb.setAngularVelocity(emptyVector)
			sleepingBodies.push(bodies.splice(i,1)[0])
			continue
		}
		// tick down the movement timeout on this die
		rb.timeout -= delta
		const ms = rb.getMotionState()
		if (ms) {
			ms.getWorldTransform(tmpBtTrans)
			let p = tmpBtTrans.getOrigin()
			let q = tmpBtTrans.getRotation()
			let j = i*8 + 1

			diceBufferView[j] = rb.id
			diceBufferView[j+1] = p.x()
			diceBufferView[j+2] = p.y()
			diceBufferView[j+3] = p.z()
			diceBufferView[j+4] = q.x()
			diceBufferView[j+5] = q.y()
			diceBufferView[j+6] = q.z()
			diceBufferView[j+7] = q.w()
		}
	}
}

let last = new Date().getTime()
const loop = () => {
	let now = new Date().getTime()
	const delta = now - last
	last = now

	if(!stopLoop && diceBufferView.byteLength) {
		// console.time("physics")
		update(delta)
		// console.timeEnd("physics")
			worldWorkerPort.postMessage({
				action: 'updates',
				diceBuffer: diceBufferView.buffer
			}, [diceBufferView.buffer])
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Forced-roll search infrastructure (Layer 1 — sequential rejection sampling)
// ─────────────────────────────────────────────────────────────────────────────

// Generate a random seed (initial pose + linear velocity + angular impulse) within the same
// envelope the production rollDie + setStartPosition use. Seeds found here can be replayed
// verbatim in the visible world to reproduce the exact same trajectory.
const generateRandomSeed = () => {
	const size = config.size
	const edgeOffset = .5
	const xMin = size * aspect / 2 - edgeOffset
	const xMax = size * aspect / -2 + edgeOffset
	const yMin = size / 2 - edgeOffset
	const yMax = size / -2 + edgeOffset
	const xEnvelope = lerp(xMin, xMax, Math.random())
	const yEnvelope = lerp(yMin, yMax, Math.random())
	const tossFromTop = Math.round(Math.random())
	const tossFromLeft = Math.round(Math.random())
	const tossX = Math.round(Math.random())
	const startPos = [
		tossX ? xEnvelope : tossFromLeft ? xMax : xMin,
		config.startingHeight,
		tossX ? (tossFromTop ? yMax : yMin) : yEnvelope,
	]

	const linearVel = [
		lerp(-startPos[0] * .5, -startPos[0] * config.throwForce, Math.random()),
		lerp(-startPos[1], -startPos[1] * 2, Math.random()),
		lerp(-startPos[2] * .5, -startPos[2] * config.throwForce, Math.random()),
	]

	const flippy = Math.random() > .5 ? 1 : -1
	const spinny = lerp(config.spinForce * .5, config.spinForce, Math.random())
	const angularImpulse = [spinny * flippy, spinny * -flippy, spinny * flippy]

	const rotation = [
		lerp(-1.5, 1.5, Math.random()),
		lerp(-1.5, 1.5, Math.random()),
		lerp(-1.5, 1.5, Math.random()),
		-1,
	]

	return { startPos, rotation, linearVel, angularImpulse }
}

// Build the production six-wall box on a caller-supplied search world. Returns body handles
// AND their construction auxiliaries so resetSearchWorld can fully reclaim wasm allocations
// (transform, shape, motionState, rbInfo per wall — leaking these per resetSearchWorld OOMs
// the heap inside ~80 seconds of soak rolling).
const addSearchBoxToWorld = (world, size, height) => {
	const localInertia = setVector3(0, 0, 0)
	const parts = []
	const aux = []

	const groundT = new Ammo.btTransform()
	groundT.setIdentity()
	groundT.setOrigin(setVector3(0, -.5, 0))
	const groundShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const groundMS = new Ammo.btDefaultMotionState(groundT)
	const groundInfo = new Ammo.btRigidBodyConstructionInfo(0, groundMS, groundShape, localInertia)
	const groundBody = new Ammo.btRigidBody(groundInfo)
	groundBody.setFriction(config.friction)
	groundBody.setRestitution(config.restitution)
	world.addRigidBody(groundBody, GROUP_WALL, MASK_WALL)
	parts.push(groundBody)
	aux.push({ transform: groundT, shape: groundShape, motionState: groundMS, rbInfo: groundInfo })

	const ceilingT = new Ammo.btTransform()
	ceilingT.setIdentity()
	ceilingT.setOrigin(setVector3(0, height - .5, 0))
	const ceilingShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const ceilingMS = new Ammo.btDefaultMotionState(ceilingT)
	const ceilingInfo = new Ammo.btRigidBodyConstructionInfo(0, ceilingMS, ceilingShape, localInertia)
	const ceilingBody = new Ammo.btRigidBody(ceilingInfo)
	ceilingBody.setFriction(config.friction)
	ceilingBody.setRestitution(config.restitution)
	world.addRigidBody(ceilingBody, GROUP_WALL, MASK_WALL)
	parts.push(ceilingBody)
	aux.push({ transform: ceilingT, shape: ceilingShape, motionState: ceilingMS, rbInfo: ceilingInfo })

	const wallSpecs = [
		{ origin: [0, 0, (size / -2) - .5], shape: [size * aspect, height, 1] },
		{ origin: [0, 0, (size / 2) + .5], shape: [size * aspect, height, 1] },
		{ origin: [(size * aspect / -2) - .5, 0, 0], shape: [1, height, size] },
		{ origin: [(size * aspect / 2) + .5, 0, 0], shape: [1, height, size] },
	]
	for (const spec of wallSpecs) {
		const t = new Ammo.btTransform()
		t.setIdentity()
		t.setOrigin(setVector3(spec.origin[0], spec.origin[1], spec.origin[2]))
		const shape = new Ammo.btBoxShape(setVector3(spec.shape[0], spec.shape[1], spec.shape[2]))
		const ms = new Ammo.btDefaultMotionState(t)
		const info = new Ammo.btRigidBodyConstructionInfo(0, ms, shape, localInertia)
		const body = new Ammo.btRigidBody(info)
		body.setFriction(config.friction)
		body.setRestitution(config.restitution)
		world.addRigidBody(body, GROUP_WALL, MASK_WALL)
		parts.push(body)
		aux.push({ transform: t, shape, motionState: ms, rbInfo: info })
	}

	return { parts, aux }
}

// Search world: rebuilt fresh per searchSeed call. Avoids OOM from constructing one per
// attempt (which we tried earlier) AND avoids cross-search state accumulation in Bullet's
// broadphase/solver cache (which we observed causing certain target values to fail
// consistently after many prior searches in the same session). Layer 2 will scale this to
// a pool of N reusable worlds with explicit reset between checkout cycles.
let searchWorld = null
let searchWorldWalls = []
let searchWorldWallAux = []
let searchWorldInfra = null  // { cc, dispatcher, broadphase, solver } — destroyed on reset

const ensureSearchWorld = () => {
	if (searchWorld) return
	const cc = new Ammo.btDefaultCollisionConfiguration()
	const dispatcher = new Ammo.btCollisionDispatcher(cc)
	const broadphase = new Ammo.btDbvtBroadphase()
	const solver = new Ammo.btSequentialImpulseConstraintSolver()
	const world = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cc)
	world.setGravity(setVector3(0, -9.81 * config.gravity, 0))
	const wallResult = addSearchBoxToWorld(world, config.size, config.startingHeight + 10)
	searchWorldWalls = wallResult.parts
	searchWorldWallAux = wallResult.aux
	searchWorldInfra = { cc, dispatcher, broadphase, solver }
	searchWorld = world
}

// Tear down the search world and rebuild fresh — call before each top-level search to
// eliminate broadphase/solver state from previous searches. Must reclaim every wasm
// allocation made in ensureSearchWorld + addSearchBoxToWorld; the prior leak (only
// destroying body + world) accumulated ~30 wasm objects per search, OOMing inside ~80s.
const resetSearchWorld = () => {
	if (searchWorld) {
		for (let i = 0; i < searchWorldWalls.length; i++) {
			searchWorld.removeRigidBody(searchWorldWalls[i])
			Ammo.destroy(searchWorldWalls[i])
			const a = searchWorldWallAux[i]
			Ammo.destroy(a.rbInfo)
			Ammo.destroy(a.motionState)
			Ammo.destroy(a.transform)
			Ammo.destroy(a.shape)
		}
		searchWorldWalls = []
		searchWorldWallAux = []
		Ammo.destroy(searchWorld)
		if (searchWorldInfra) {
			Ammo.destroy(searchWorldInfra.solver)
			Ammo.destroy(searchWorldInfra.broadphase)
			Ammo.destroy(searchWorldInfra.dispatcher)
			Ammo.destroy(searchWorldInfra.cc)
			searchWorldInfra = null
		}
		searchWorld = null
	}
	ensureSearchWorld()
}

// Run one simulation with N dice in the persistent search world: each thrown with its own
// seed, all share the same world (so collisions between them mirror the visible playback).
// Fast-forwards until ALL bodies settle, returns array of resting rotations [x,y,z,w] per
// body, or null if any didn't settle in time. Used by both single-die and pair-die searches.
const simulateOnceN = (seeds, dieTypes, meshName) => {
	ensureSearchWorld()
	const bodies = []

	for (let k = 0; k < seeds.length; k++) {
		const cKey = `${meshName}_${dieTypes[k]}_collider`
		const colliderInfo = colliders[cKey]
		if (!colliderInfo) {
			// roll back any bodies already added before bailing
			for (const b of bodies) { searchWorld.removeRigidBody(b); destroyBody(b) }
			return null
		}
		const colliderMass = colliderInfo.physicsMass || .1
		const mass = colliderMass * config.mass * config.scale
		const dieBody = createRigidBody(colliderInfo.convexHull, {
			mass,
			scaling: colliderInfo.scaling,
			pos: seeds[k].startPos,
			quat: seeds[k].rotation,
		})
		dieBody.mass = mass
		// search world is rebuilt per top-level search and contains only walls + these dice;
		// all search dice share SEARCH_SLOT so multi-dice searches collide with each other
		// (matching the production replay where same-collection dice share a slot too)
		searchWorld.addRigidBody(dieBody, SEARCH_SLOT, GROUP_WALL | SEARCH_SLOT)
		dieBody.setLinearVelocity(setVector3(seeds[k].linearVel[0], seeds[k].linearVel[1], seeds[k].linearVel[2]))
		const force = new Ammo.btVector3(seeds[k].angularImpulse[0], seeds[k].angularImpulse[1], seeds[k].angularImpulse[2])
		const impulseScale = Math.abs(config.scale - 1) + config.scale * config.scale * (mass / config.mass) * .75
		dieBody.applyImpulse(force, setVector3(impulseScale, impulseScale, impulseScale))
		Ammo.destroy(force)
		bodies.push(dieBody)
	}

	// fast-forward at 1/90s fixed substeps until ALL bodies settle. cap at ~6.6s simulated.
	const maxSteps = 600
	let allSettled = false
	for (let i = 0; i < maxSteps; i++) {
		searchWorld.stepSimulation(1/90, 1, 1/90)
		allSettled = true
		for (const b of bodies) {
			const speed = b.getLinearVelocity().length()
			const tilt = b.getAngularVelocity().length()
			if (speed >= .01 || tilt >= .005) { allSettled = false; break }
		}
		if (allSettled) break
	}

	let results = null
	if (allSettled) {
		results = []
		const tmpT = new Ammo.btTransform()
		for (const b of bodies) {
			b.getMotionState().getWorldTransform(tmpT)
			const q = tmpT.getRotation()
			results.push([q.x(), q.y(), q.z(), q.w()])
		}
		Ammo.destroy(tmpT)
	}

	// teardown — remove + destroyBody reclaims the full chain (body + motionState +
	// transform + rbInfo + btQuaternion). search hot path runs ~50 attempts per d20 search
	// so this is the primary leak source under sustained rolling.
	for (const b of bodies) {
		searchWorld.removeRigidBody(b)
		destroyBody(b)
	}

	return results
}

// Single-die wrapper for backwards compatibility with doSearch().
const simulateOnce = (seed, dieType, meshName) => {
	const results = simulateOnceN([seed], [dieType], meshName)
	return results ? results[0] : null
}

// Determine which face is up given a final rotation. Rotates each precomputed local face
// normal by the rotation quaternion, picks the face whose world normal best aligns with
// (0, ±1, 0), looks up faceMap[faceId] for the value.
const evaluateFace = (rotation, faceKey) => {
	const data = faceData[faceKey]
	if (!data) return null
	const { faceNormals, faceMap, d4FaceDown, dieType } = data
	const upY = (dieType === 'd4' && d4FaceDown) ? -1 : 1
	const qx = rotation[0], qy = rotation[1], qz = rotation[2], qw = rotation[3]
	const numFaces = faceNormals.length / 3
	let bestFaceId = -1
	let bestDot = -Infinity
	for (let i = 0; i < numFaces; i++) {
		const nx = faceNormals[i * 3]
		const ny = faceNormals[i * 3 + 1]
		const nz = faceNormals[i * 3 + 2]
		// y-component of q*v*q⁻¹ for unit q. v + qw*(2(u×v)) + 2(u×(u×v)) where u = (qx,qy,qz)
		const tx = 2 * (qy * nz - qz * ny)
		const ty = 2 * (qz * nx - qx * nz)
		const tz = 2 * (qx * ny - qy * nx)
		const ry = ny + qw * ty + (qz * tx - qx * tz)
		const dot = upY * ry
		if (dot > bestDot) {
			bestDot = dot
			bestFaceId = i
		}
	}
	return faceMap[bestFaceId]
}

// Pair-search for d100: throws BOTH the d100 body and its inner d10 in the same search
// world (so collisions between them mirror the visible playback's two-body simulation).
// Hit rate ~1/100 per attempt instead of 1/10 × 1/10 — but the resulting seeds reproduce
// faithfully because the visible world has the same collision dynamics. Returns a paired
// seed where the d10's seed is nested under .d10Seed.
const doPairSearch = (req) => {
	const { searchId, meshName, tensValue, unitsValue, maxAttempts = 100 } = req
	const tensFaceKey = `${meshName}_d100`
	const unitsFaceKey = `${meshName}_d10`
	const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()

	if (!faceData[tensFaceKey] || !faceData[unitsFaceKey]
		|| !colliders[`${meshName}_d100_collider`] || !colliders[`${meshName}_d10_collider`]) {
		worldWorkerPort.postMessage({
			action: 'searchResult', searchId, found: false,
			error: 'missing_face_data_or_collider', attempts: 0,
		})
		return
	}

	// fresh world per top-level search — eliminates cross-search broadphase/solver state
	resetSearchWorld()

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const tensSeed = generateRandomSeed()
		const unitsSeed = generateRandomSeed()
		const results = simulateOnceN([tensSeed, unitsSeed], ['d100', 'd10'], meshName)
		if (!results) continue
		const tensActual = evaluateFace(results[0], tensFaceKey)
		const unitsActual = evaluateFace(results[1], unitsFaceKey)
		if (tensActual === tensValue && unitsActual === unitsValue) {
			const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start
			worldWorkerPort.postMessage({
				action: 'searchResult', searchId, found: true,
				seed: { ...tensSeed, d10Seed: unitsSeed },
				attempts: attempt, elapsedMs: elapsed,
				// (0,0) → 100 per dice-box convention, otherwise straight sum
				restingValue: (tensValue === 0 && unitsValue === 0) ? 100 : tensValue + unitsValue,
			})
			return
		}
	}

	const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start
	worldWorkerPort.postMessage({
		action: 'searchResult', searchId, found: false,
		attempts: maxAttempts, elapsedMs: elapsed,
	})
}

// Multi-dice rejection sampling: throw N independent dice in the SAME search world (so
// collision dynamics mirror visible playback) until ALL land on their respective targets.
// Returns a paired seed where each subsequent die's seed is nested under .d10Seed-style
// chained property (the visible playback path uses options.seed.d10Seed for d100; for
// other multi-die we use a generic .extraSeeds: [seed1, seed2, ...] array).
//
// Hit rate is product of per-die hit rates: 2d20 = 1/400, 4d6 = 1/1296. Latency scales
// accordingly. Default cap bumped per req; caller should size maxAttempts to the case.
const doMultiSearch = (req) => {
	const { searchId, meshName, dieTypes, targetValues, maxAttempts = 500 } = req
	const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()

	// validate face data + colliders for every die type involved
	for (const dt of dieTypes) {
		const faceKey = `${meshName}_${dt}`
		const colliderKey = `${meshName}_${dt}_collider`
		if (!faceData[faceKey] || !colliders[colliderKey]) {
			worldWorkerPort.postMessage({
				action: 'searchResult', searchId, found: false,
				error: `missing_face_data_or_collider:${dt}`, attempts: 0,
			})
			return
		}
	}

	resetSearchWorld()

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const seeds = dieTypes.map(() => generateRandomSeed())
		const results = simulateOnceN(seeds, dieTypes, meshName)
		if (!results) continue
		// check all dice match their targets
		let ok = true
		for (let k = 0; k < dieTypes.length; k++) {
			const v = evaluateFace(results[k], `${meshName}_${dieTypes[k]}`)
			if (v !== targetValues[k]) { ok = false; break }
		}
		if (ok) {
			const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start
			// primary seed is seeds[0]; remaining seeds delivered via extraSeeds for
			// world.onscreen to forward to subsequent addDie calls in this collection
			worldWorkerPort.postMessage({
				action: 'searchResult', searchId, found: true,
				seed: { ...seeds[0], extraSeeds: seeds.slice(1) },
				attempts: attempt, elapsedMs: elapsed,
				restingValues: targetValues.slice(),
			})
			return
		}
	}

	const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start
	worldWorkerPort.postMessage({
		action: 'searchResult', searchId, found: false,
		attempts: maxAttempts, elapsedMs: elapsed,
	})
}

// Sequential rejection sampling. Generates random seeds and simulates each in an isolated
// world until one lands on targetValue, or maxAttempts exhausted. Posts result back to
// the rendering worker via "searchResult".
const doSearch = (req) => {
	const { searchId, dieType, meshName, targetValue, maxAttempts = 100 } = req
	const faceKey = `${meshName}_${dieType}`
	const colliderKey = `${meshName}_${dieType}_collider`
	const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()

	if (!faceData[faceKey] || !colliders[colliderKey]) {
		worldWorkerPort.postMessage({
			action: 'searchResult',
			searchId,
			found: false,
			error: 'missing_face_data_or_collider',
			attempts: 0,
		})
		return
	}

	// fresh world per top-level search — eliminates cross-search broadphase/solver state
	resetSearchWorld()

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const seed = generateRandomSeed()
		const finalRotation = simulateOnce(seed, dieType, meshName)
		if (!finalRotation) continue
		const value = evaluateFace(finalRotation, faceKey)
		if (value === targetValue) {
			const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start
			worldWorkerPort.postMessage({
				action: 'searchResult',
				searchId,
				found: true,
				seed,
				attempts: attempt,
				elapsedMs: elapsed,
				restingValue: value,
				restingRotation: finalRotation,
			})
			return
		}
	}

	const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start
	worldWorkerPort.postMessage({
		action: 'searchResult',
		searchId,
		found: false,
		attempts: maxAttempts,
		elapsedMs: elapsed,
	})
}
