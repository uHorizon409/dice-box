// Layer 2 — parallel search worker pool. Spawns N copies of physics.worker.js in
// search-only mode, broadcasts colliders + face data to all of them, and races search
// requests across them.
//
// Architecture:
//   - Pool init waits for the rendering worker to load + relay the first theme's
//     colliders and per-die-type face data (captured in WorldOffScreen). On each
//     subsequent theme, WorldFacade re-broadcasts to existing pool workers.
//   - searchSeed picks K idle workers, distributes `maxAttempts/K` attempts each with
//     distinct searchIds, races their `searchResult` messages, sends "abort" to losers.
//     First found-true wins. All-exhausted -> found:false.
//   - JS Math.random() is per-realm; each worker's RNG is uncorrelated, so distributing
//     attempts across workers gives ~Kx speedup with no overlap or wasted work.
//
// Memory: ~5MB Ammo wasm runtime per worker. POOL_SIZE chosen to leave 2 cores for the
// main thread + the existing rendering+physics pair. Cap at 8 to avoid context-switch
// overhead exceeding speedup on high-core boxes.
import physicsWorker from './physics.worker.js?worker&inline'

const POOL_SIZE = Math.min(8, Math.max(1, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 2))

class SearchPool {
	constructor(config) {
		this.config = config
		this.workers = []
		this.idle = new Set()
		this.busy = new Set()
		this.initPromise = null
		this.initialized = false
		this.modelsLoaded = new Set()  // meshNames already broadcast
		this.faceDataLoaded = new Set() // keys (e.g. "smooth_d20") already broadcast
		// queue payloads that arrive before init completes; drained inside init() after
		// all workers report init-complete.
		this.preInitQueue = []
		// per-search state: searchId -> { worker -> resolved? }
		this.searches = new Map()
		this.disabled = false  // true after destroy() so subsequent searches fall through
	}

	// spawn workers, send the same `init` payload the existing single-worker gets, plus
	// searchOnly:true. Returns a promise that resolves when ALL workers report init-complete.
	// On any spawn or init failure the whole pool disables itself — caller falls back to
	// the single-worker path.
	async init(initPayload) {
		if (this.initPromise) return this.initPromise
		this.initPromise = (async () => {
			try {
				const initOK = []
				for (let i = 0; i < POOL_SIZE; i++) {
					const w = new physicsWorker()
					w._poolIdx = i
					this.workers.push(w)
					this.idle.add(w)
					initOK.push(new Promise((resolve, reject) => {
						const onceInit = (e) => {
							if (e.data.action === 'init-complete') {
								w.removeEventListener('message', onceInit)
								resolve()
							}
						}
						w.addEventListener('message', onceInit)
						w.addEventListener('error', (err) => reject(err), { once: true })
					}))
					w.postMessage({
						action: 'init',
						searchOnly: true,
						width: initPayload.width,
						height: initPayload.height,
						options: initPayload.options,
					})
				}
				await Promise.all(initOK)
				// per-worker permanent listener routes searchResult by searchId
				for (const w of this.workers) {
					w.addEventListener('message', (e) => this._onWorkerMessage(w, e))
				}
				this.initialized = true
				// drain anything that arrived before init completed
				const queued = this.preInitQueue
				this.preInitQueue = []
				for (const fn of queued) fn()
			} catch (err) {
				console.warn('[search-pool] init failed, disabling pool', err)
				this.disabled = true
			}
		})()
		return this.initPromise
	}

	// broadcast colliders to all pool workers. Idempotent per meshName. Queued if init
	// hasn't completed yet (relay capture may fire before pool workers are ready).
	loadModels(payload) {
		if (this.disabled) return
		if (this.modelsLoaded.has(payload.meshName)) return
		if (!this.initialized) {
			this.preInitQueue.push(() => this.loadModels(payload))
			return
		}
		this.modelsLoaded.add(payload.meshName)
		for (const w of this.workers) {
			w.postMessage({ action: 'loadModels', options: payload })
		}
	}

	// broadcast a single face-data entry to all pool workers. Idempotent per key. Queued
	// pre-init same as loadModels.
	loadFaceData(entry) {
		if (this.disabled) return
		if (this.faceDataLoaded.has(entry.key)) return
		if (!this.initialized) {
			this.preInitQueue.push(() => this.loadFaceData(entry))
			return
		}
		this.faceDataLoaded.add(entry.key)
		for (const w of this.workers) {
			w.postMessage({
				action: 'loadFaceData',
				key: entry.key,
				dieType: entry.dieType,
				faceNormals: new Float32Array(entry.faceNormalsArr).buffer,
				faceMap: entry.faceMap,
				d4FaceDown: entry.d4FaceDown,
			})
		}
	}

	// dispatch a search across K idle workers, race results, abort losers. Resolves with
	// the same shape the single-worker searchSeed returns. If pool unavailable (init not
	// done, disabled, or no idle workers), throws — caller falls back.
	async searchSeed(req) {
		if (this.disabled) throw new Error('pool-disabled')
		if (!this.initPromise) throw new Error('pool-not-initialized')
		await this.initPromise
		if (this.disabled) throw new Error('pool-disabled')

		const idleArr = [...this.idle]
		if (idleArr.length === 0) throw new Error('pool-busy')

		// distribute attempts: each picked worker gets ceil(maxAttempts/K) attempts. With K
		// workers running in parallel, expected total attempts to first hit is unchanged;
		// wallclock latency is divided by K.
		const K = idleArr.length
		const totalAttempts = req.maxAttempts || 100
		const perWorker = Math.ceil(totalAttempts / K)

		// key the search map by stringified searchId — req.searchId from WorldFacade is a
		// number, but parentId on reply lookup is parsed out of "N#k" via slice() which
		// produces a string. Map.get strict-equality means number-vs-string keys never match,
		// so ALL replies were being silently dropped (watchdog-fire bug).
		const parentKey = String(req.searchId)
		const search = { resolvers: [], firstHit: null, returnedCount: 0, K, parentKey }
		this.searches.set(parentKey, search)

		const promise = new Promise((resolve, reject) => {
			search.finalResolve = resolve
			// watchdog: if no worker has replied within 10s, something's stuck — release the
			// stuck workers, fail the search, and let WorldFacade fall through to the single-
			// worker path. Catches hung yieldToEventLoop, dropped postMessage, etc.
			search.watchdog = setTimeout(() => {
				if (!this.searches.has(parentKey)) return
				this.searches.delete(parentKey)
				console.warn('[search-pool] search', parentKey, 'timed out — releasing workers and falling through')
				for (const r of search.resolvers) {
					this.busy.delete(r.worker)
					this.idle.add(r.worker)
				}
				reject(new Error('pool-search-timeout'))
			}, 10000)
		})

		// hand off chosen workers to busy and dispatch with distinct sub-searchIds so
		// per-worker results don't collide. action:'searchSeed' is required — pool workers
		// don't have a connect-port handler, they receive at top level via self.onmessage.
		for (let i = 0; i < K; i++) {
			const w = idleArr[i]
			this.idle.delete(w)
			this.busy.add(w)
			const subId = `${req.searchId}#${i}`
			search.resolvers.push({ worker: w, subId })
			w.postMessage({ ...req, action: 'searchSeed', searchId: subId, maxAttempts: perWorker })
		}

		return promise
	}

	_onWorkerMessage(worker, e) {
		if (e.data.action !== 'searchResult') return
		// extract parent searchId from "parent#k"
		const subId = e.data.searchId
		const hash = subId.indexOf('#')
		if (hash < 0) return
		const parentId = subId.slice(0, hash)

		// release this worker regardless of search state — even if the search already
		// resolved via a peer's first-hit, this reply means this worker is done with
		// its current message and can take new work.
		this.busy.delete(worker)
		this.idle.add(worker)

		const search = this.searches.get(parentId)
		if (!search) return  // search already resolved by a peer's first-hit; this is a stale reply

		// first hit wins: resolve user promise IMMEDIATELY rather than waiting for all K
		// to return. Losers get an abort message — they'll bail on the next yield-checkpoint
		// inside their search loop and reply found:false,aborted:true. delete search entry
		// so those late replies just release workers without re-resolving.
		if (e.data.found) {
			clearTimeout(search.watchdog)
			this.searches.delete(parentId)
			// restore numeric searchId for WorldOffScreen.pendingSearches lookup (number-keyed)
			const numericSearchId = Number(parentId)
			search.finalResolve({ ...e.data, searchId: Number.isNaN(numericSearchId) ? parentId : numericSearchId })
			for (const r of search.resolvers) {
				if (r.worker !== worker) r.worker.postMessage({ action: 'abort' })
			}
			return
		}

		// not a hit — track and exhaust if all K replied without finding
		search.returnedCount++
		if (search.returnedCount >= search.K) {
			clearTimeout(search.watchdog)
			this.searches.delete(parentId)
			const numericSearchId = Number(parentId)
			search.finalResolve({
				action: 'searchResult',
				searchId: Number.isNaN(numericSearchId) ? parentId : numericSearchId,
				found: false,
				attempts: search.K * (e.data.attempts || 0),
				elapsedMs: e.data.elapsedMs || 0,
			})
		}
	}

	destroy() {
		this.disabled = true
		for (const w of this.workers) {
			try { w.terminate() } catch (_) {}
		}
		this.workers = []
		this.idle.clear()
		this.busy.clear()
	}
}

export default SearchPool
export { POOL_SIZE }
