import { engine, Entity } from '@dcl/sdk/ecs'

// Lazy + guarded: importing '@dcl/sdk/network' runs comms setup at module
// load, which crashed the whole bundle on the mobile explorer (scene loaded
// but no code ran). Loaded on demand; when unavailable, attach requests are
// still created locally and a warning is logged instead of crashing.
type SyncEntityFn = (entityId: Entity, componentIds: number[], entityEnumId?: number) => void
let syncEntityFn: SyncEntityFn | null = null
let networkLoadStarted = false

export function ensureNetworkModule(): void {
  if (networkLoadStarted) return
  networkLoadStarted = true
  import('@dcl/sdk/network')
    .then(m => { syncEntityFn = m.syncEntity })
    .catch(err => console.log(`[CLIENT] network module unavailable: ${err}`))
}
import { RoundState, GameTimer, AttachRequest } from '../shared/components'
import { RoundPhase, STALE_THRESHOLD_MS } from '../shared/constants'

// Resolved at runtime once the server's syncEntity records arrive. ESM live
// bindings let other modules read the up-to-date entity even after the
// initial 0 value.
export let roundEntity: Entity = 0 as Entity
export let timerEntity: Entity = 0 as Entity

let localPlayerId = ''
let localDisplayName = ''
let attachSeq = 0
let resolvedLogged = false

// Freshness tracking — used by the cinematic and HUD to detect stale CRDT.
let lastObservedPhase: RoundPhase = 'IDLE'
let lastObservedRound = 0
let lastObservedTemplate = ''
let lastObservedSeq = 0
let lastObservedAtMs = 0

export interface ClientSnapshot {
  resolved: boolean
  phase: RoundPhase
  roundNumber: number
  templateId: string
  partsAttached: number
  partsRequired: number
  occupiedMask: number
  performanceType: string
  builders: string
  secondsLeft: number
  stateSeq: number
  ageMs: number
  isStale: boolean
}

export function getClientSnapshot(): ClientSnapshot {
  const empty: ClientSnapshot = {
    resolved: false, phase: 'IDLE', roundNumber: 0, templateId: '',
    partsAttached: 0, partsRequired: 0, occupiedMask: 0, performanceType: '', builders: '',
    secondsLeft: 0, stateSeq: 0, ageMs: Number.POSITIVE_INFINITY, isStale: true
  }
  if (!roundEntity || roundEntity === (0 as Entity)) return empty
  try {
    const rs = RoundState.get(roundEntity)
    let secondsLeft = 0
    try { secondsLeft = GameTimer.get(timerEntity).secondsLeft } catch (_) {}
    const ageMs = lastObservedAtMs ? Date.now() - lastObservedAtMs : Number.POSITIVE_INFINITY
    const isStale = ageMs >= STALE_THRESHOLD_MS && rs.phase !== 'IDLE'
    return {
      resolved: true,
      phase: rs.phase as RoundPhase,
      roundNumber: rs.roundNumber,
      templateId: rs.templateId,
      partsAttached: rs.partsAttached,
      partsRequired: rs.partsRequired,
      occupiedMask: rs.occupiedMask ?? 0,
      performanceType: rs.performanceType,
      builders: rs.builders ?? '',
      secondsLeft,
      stateSeq: rs.stateSeq ?? 0,
      ageMs,
      isStale
    }
  } catch (_) {
    return empty
  }
}

// Late joiners can briefly see a transient RoundState entity before the
// authoritative one syncs. The real one has the highest stateSeq (and
// roundNumber), so prefer that each frame.
function resolveAuthoritativeEntities(): void {
  let bestSeq = -1
  let bestRound = -1
  let pick: Entity | null = null
  for (const [e] of engine.getEntitiesWith(RoundState)) {
    try {
      const rs = RoundState.get(e)
      const seq = rs.stateSeq ?? 0
      const rn = rs.roundNumber ?? 0
      if (seq > bestSeq || (seq === bestSeq && rn > bestRound)) {
        bestSeq = seq
        bestRound = rn
        pick = e
      }
    } catch (_) {}
  }
  if (pick !== null) roundEntity = pick

  if (!timerEntity || timerEntity === (0 as Entity)) {
    for (const [e] of engine.getEntitiesWith(GameTimer)) {
      timerEntity = e
      break
    }
  }

  if (!resolvedLogged && roundEntity !== (0 as Entity) && timerEntity !== (0 as Entity)) {
    resolvedLogged = true
    console.log(`[CLIENT] entities resolved round=${roundEntity} timer=${timerEntity}`)
  }
}

export function clientResolveSystem(_dt: number): void {
  resolveAuthoritativeEntities()
  if (roundEntity === (0 as Entity)) return
  try {
    const rs = RoundState.get(roundEntity)
    const seq = rs.stateSeq ?? 0
    if (
      rs.phase !== lastObservedPhase ||
      rs.roundNumber !== lastObservedRound ||
      rs.templateId !== lastObservedTemplate ||
      seq !== lastObservedSeq
    ) {
      const isPhaseChange = rs.phase !== lastObservedPhase || rs.roundNumber !== lastObservedRound
      lastObservedPhase = rs.phase as RoundPhase
      lastObservedRound = rs.roundNumber
      lastObservedTemplate = rs.templateId
      lastObservedSeq = seq
      lastObservedAtMs = Date.now()
      if (isPhaseChange) {
        console.log(
          `[CLIENT] phase=${rs.phase} round=${rs.roundNumber} template=${rs.templateId} ` +
          `parts=${rs.partsAttached}/${rs.partsRequired} mask=${rs.occupiedMask} seq=${seq}`
        )
      }
    }

  } catch (_) {}
}

export function setLocalPlayer(playerId: string, displayName: string): void {
  localPlayerId = playerId
  localDisplayName = displayName || playerId.slice(0, 8)
  // Kick off the network module load now so syncEntity is ready well before
  // the first click. Guarded internally; never throws.
  ensureNetworkModule()
}

export function updateLocalDisplayName(displayName: string): void {
  if (!displayName) return
  localDisplayName = displayName
}

export function getLocalPlayerId(): string { return localPlayerId }

// Build a placement request and send via CRDT (authoritative path) plus an
// optional UX hint. The server validates everything.
export function requestAttach(slotId: string, partType: string): string {
  const requestId = `${localPlayerId || 'anon'}:${slotId}:${++attachSeq}:${Date.now()}`
  let templateId = ''
  let roundNumber = 0
  try {
    const rs = RoundState.get(roundEntity)
    templateId = rs.templateId
    roundNumber = rs.roundNumber
  } catch (_) {}

  const e = engine.addEntity()
  AttachRequest.create(e, {
    requestId,
    playerId: localPlayerId,
    displayName: localDisplayName,
    slotId,
    partType,
    templateId,
    roundNumber
  })
  if (syncEntityFn !== null) {
    try { syncEntityFn(e, [AttachRequest.componentId]) } catch (err) {
      console.log(`[CLIENT] syncEntity failed: ${err}`)
    }
  } else {
    console.log('[CLIENT] attach created without sync — network module not ready')
  }
  console.log(`[CLIENT] attach ${requestId} ${templateId}#${roundNumber} ${slotId}/${partType}`)
  return requestId
}

