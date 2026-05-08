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
			aspect = width / height
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
						doSearch(e.data)
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
	aspect = width / height

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
	transform.setRotation(
		new Ammo.btQuaternion(quat[0], quat[1], quat[2], quat[3])
	)
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
// cache for box parts so it can be removed after a new one has been made
let boxParts = []
const addBoxToWorld = (size, height) => {
	const tempParts = []
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
	physicsWorld.addRigidBody(groundBody)
	tempParts.push(groundBody)

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
	physicsWorld.addRigidBody(ceilingBody)
	tempParts.push(ceilingBody)

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
	physicsWorld.addRigidBody(topBody)
	tempParts.push(topBody)

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
	physicsWorld.addRigidBody(bottomBody)
	tempParts.push(bottomBody)

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
	physicsWorld.addRigidBody(rightBody)
	tempParts.push(rightBody)

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
	physicsWorld.addRigidBody(leftBody)
	tempParts.push(leftBody)

	if(boxParts.length){
		removeBoxFromWorld()
	}
	boxParts = [...tempParts]
}

const removeBoxFromWorld = () => {
	boxParts.forEach(part => physicsWorld.removeRigidBody(part))
}

const addDie = (options) => {
	const { sides, id, meshName, scale, seed } = options
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
	physicsWorld.addRigidBody(newDie)
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
			// remove the mesh from the scene
			physicsWorld.removeRigidBody(die)
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
	// clear all bodies
	bodies.forEach(body => physicsWorld.removeRigidBody(body))
	sleepingBodies.forEach(body => physicsWorld.removeRigidBody(body))
	// clear cache arrays
	bodies = []
	sleepingBodies = []
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

                // Calculate relative velocity
                const relativeVelocity = new Ammo.btVector3();
                relativeVelocity.setValue(
                    velocity0.x() - velocity1.x(),
                    velocity0.y() - velocity1.y(),
                    velocity0.z() - velocity1.z()
                );

                // Calculate the force (F = m * a) based on velocity and collision normal
                const collisionForce = normal.dot(relativeVelocity);
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

// Build the production six-wall box on a caller-supplied search world. Returns the body
// handles so the caller can clean them up after the search is done.
const addSearchBoxToWorld = (world, size, height) => {
	const localInertia = setVector3(0, 0, 0)
	const parts = []

	const groundT = new Ammo.btTransform()
	groundT.setIdentity()
	groundT.setOrigin(setVector3(0, -.5, 0))
	const groundShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const groundMS = new Ammo.btDefaultMotionState(groundT)
	const groundInfo = new Ammo.btRigidBodyConstructionInfo(0, groundMS, groundShape, localInertia)
	const groundBody = new Ammo.btRigidBody(groundInfo)
	groundBody.setFriction(config.friction)
	groundBody.setRestitution(config.restitution)
	world.addRigidBody(groundBody)
	parts.push(groundBody)

	const ceilingT = new Ammo.btTransform()
	ceilingT.setIdentity()
	ceilingT.setOrigin(setVector3(0, height - .5, 0))
	const ceilingShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const ceilingMS = new Ammo.btDefaultMotionState(ceilingT)
	const ceilingInfo = new Ammo.btRigidBodyConstructionInfo(0, ceilingMS, ceilingShape, localInertia)
	const ceilingBody = new Ammo.btRigidBody(ceilingInfo)
	ceilingBody.setFriction(config.friction)
	ceilingBody.setRestitution(config.restitution)
	world.addRigidBody(ceilingBody)
	parts.push(ceilingBody)

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
		world.addRigidBody(body)
		parts.push(body)
	}

	return parts
}

// Persistent search world: built once, reused across all search attempts. Avoids OOM from
// constructing+leaking a full Ammo world per attempt. Layer 2 will scale this to a pool of N.
let searchWorld = null

const ensureSearchWorld = () => {
	if (searchWorld) return
	const cc = new Ammo.btDefaultCollisionConfiguration()
	const dispatcher = new Ammo.btCollisionDispatcher(cc)
	const broadphase = new Ammo.btDbvtBroadphase()
	const solver = new Ammo.btSequentialImpulseConstraintSolver()
	const world = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cc)
	world.setGravity(setVector3(0, -9.81 * config.gravity, 0))
	addSearchBoxToWorld(world, config.size, config.startingHeight + 10)
	searchWorld = world
}

// Run one simulation in the persistent search world: add a die thrown with the given seed,
// fast-forward at fixed 1/90s substeps until settle, read final rotation, remove the die.
// Returns the resting rotation as [x,y,z,w], or null if the die didn't settle in time.
const simulateOnce = (seed, dieType, meshName) => {
	ensureSearchWorld()
	const cKey = `${meshName}_${dieType}_collider`
	const colliderInfo = colliders[cKey]
	if (!colliderInfo) return null

	const colliderMass = colliderInfo.physicsMass || .1
	const mass = colliderMass * config.mass * config.scale
	const dieBody = createRigidBody(colliderInfo.convexHull, {
		mass,
		scaling: colliderInfo.scaling,
		pos: seed.startPos,
		quat: seed.rotation,
	})
	dieBody.mass = mass
	searchWorld.addRigidBody(dieBody)

	dieBody.setLinearVelocity(setVector3(seed.linearVel[0], seed.linearVel[1], seed.linearVel[2]))
	const force = new Ammo.btVector3(seed.angularImpulse[0], seed.angularImpulse[1], seed.angularImpulse[2])
	const impulseScale = Math.abs(config.scale - 1) + config.scale * config.scale * (mass / config.mass) * .75
	dieBody.applyImpulse(force, setVector3(impulseScale, impulseScale, impulseScale))
	Ammo.destroy(force)

	// fast-forward at 1/90s fixed substeps until settle. cap at ~6.6s of simulated time.
	const maxSteps = 600
	let settled = false
	for (let i = 0; i < maxSteps; i++) {
		searchWorld.stepSimulation(1/90, 1, 1/90)
		const speed = dieBody.getLinearVelocity().length()
		const tilt = dieBody.getAngularVelocity().length()
		if (speed < .01 && tilt < .005) {
			settled = true
			break
		}
	}

	let result = null
	if (settled) {
		const tmpT = new Ammo.btTransform()
		dieBody.getMotionState().getWorldTransform(tmpT)
		const q = tmpT.getRotation()
		result = [q.x(), q.y(), q.z(), q.w()]
		Ammo.destroy(tmpT)
	}

	// remove the die from the world and destroy it. the motion state, construction info, and
	// transform allocated inside createRigidBody are not directly accessible — they leak per
	// attempt (~280 bytes total) but at 100 attempts that's only ~28KB. acceptable for Layer 1.
	searchWorld.removeRigidBody(dieBody)
	Ammo.destroy(dieBody)

	return result
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
