import { engine, Entity } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { RoundState, GameTimer, AttachRequest, ux } from '../shared/components'
import {
  BUILD_DURATION_SECONDS,
  BUILD_COMPLETE_SECONDS,
  COUNTDOWN_SECONDS,
  PERFORMANCE_DURATION_SECONDS,
  RESET_DELAY_SECONDS,
  RoundPhase,
  getPerformanceType
} from '../shared/constants'
import { TEMPLATES, TEMPLATE_ORDER, findSlotIndex } from '../shared/templates'

const ROUND_ENTITY_ENUM_ID = 1
const TIMER_ENTITY_ENUM_ID = 2

let roundEntity: Entity = 0 as Entity
let timerEntity: Entity = 0 as Entity

let currentPhase: RoundPhase = 'IDLE'
let templateIndex = 0
let timerAccumulator = 0

const slotPlacedBy: Record<string, string> = {}
const processedRequestIds: Record<string, true> = {}

export function initServer(): void {
  roundEntity = engine.addEntity()
  RoundState.create(roundEntity, {
    phase: 'IDLE',
    roundNumber: 0,
    templateId: TEMPLATE_ORDER[0],
    partsAttached: 0,
    partsRequired: TEMPLATES[TEMPLATE_ORDER[0]].length,
    occupiedMask: 0,
    performanceType: '',
    stateSeq: 0
  })
  syncEntity(roundEntity, [RoundState.componentId], ROUND_ENTITY_ENUM_ID)

  timerEntity = engine.addEntity()
  GameTimer.create(timerEntity, { secondsLeft: BUILD_DURATION_SECONDS })
  syncEntity(timerEntity, [GameTimer.componentId], TIMER_ENTITY_ENUM_ID)

  console.log('[SERVER] initialized — first round begins shortly')
  setTimeout(() => enterBuild(), 1000)
  engine.addSystem(serverTick, 1, 'dbc:serverTick')
}

//  Helpers 
function bumpSeq(): number {
  const rs = RoundState.getMutable(roundEntity)
  rs.stateSeq = (rs.stateSeq || 0) + 1
  return rs.stateSeq
}

function setPhase(phase: RoundPhase): void {
  currentPhase = phase
  RoundState.getMutable(roundEntity).phase = phase
  bumpSeq()
}

function setTimerSeconds(seconds: number): void {
  GameTimer.getMutable(timerEntity).secondsLeft = seconds
  timerAccumulator = 0
}

// Phase entry points 
function enterBuild(): void {
  const nextRound = RoundState.get(roundEntity).roundNumber + 1
  const templateId = TEMPLATE_ORDER[templateIndex % TEMPLATE_ORDER.length]
  const required = TEMPLATES[templateId].length

  const rs = RoundState.getMutable(roundEntity)
  rs.phase = 'BUILD'
  rs.roundNumber = nextRound
  rs.templateId = templateId
  rs.partsAttached = 0
  rs.partsRequired = required
  rs.occupiedMask = 0
  rs.performanceType = ''
  rs.stateSeq = (rs.stateSeq || 0) + 1

  currentPhase = 'BUILD'

  for (const k of Object.keys(slotPlacedBy)) delete slotPlacedBy[k]
  for (const k of Object.keys(processedRequestIds)) delete processedRequestIds[k]

  setTimerSeconds(BUILD_DURATION_SECONDS)

  console.log(`[SERVER] BUILD round=${nextRound} template=${templateId} required=${required}`)
}

function enterBuildComplete(reason: 'perfect' | 'timeout'): void {
  if (currentPhase !== 'BUILD') return
  const rs = RoundState.getMutable(roundEntity)
  rs.performanceType = getPerformanceType(rs.partsAttached, rs.partsRequired)
  setPhase('BUILD_COMPLETE')
  setTimerSeconds(BUILD_COMPLETE_SECONDS)
  console.log(
    `[SERVER] BUILD_COMPLETE reason=${reason} round=${rs.roundNumber} ` +
    `parts=${rs.partsAttached}/${rs.partsRequired} perf=${rs.performanceType}`
  )
}

function enterCountdown(): void {
  if (currentPhase !== 'BUILD_COMPLETE') return
  setPhase('COUNTDOWN')
  setTimerSeconds(COUNTDOWN_SECONDS)
  console.log(`[SERVER] COUNTDOWN round=${RoundState.get(roundEntity).roundNumber}`)
}

function enterPerform(): void {
  if (currentPhase !== 'COUNTDOWN') return
  setPhase('PERFORM')
  setTimerSeconds(PERFORMANCE_DURATION_SECONDS)
  console.log(`[SERVER] PERFORM round=${RoundState.get(roundEntity).roundNumber}`)
}

function enterReset(): void {
  if (currentPhase !== 'PERFORM') return
  templateIndex += 1
  setPhase('RESET')
  setTimerSeconds(RESET_DELAY_SECONDS)
  console.log(`[SERVER] RESET round=${RoundState.get(roundEntity).roundNumber}`)
}

//  Attach request handling
function handleAttachRequest(
  requestId: string,
  playerId: string,
  slotId: string,
  partType: string,
  templateId: string,
  roundNumber: number
): void {
  if (processedRequestIds[requestId]) return
  processedRequestIds[requestId] = true

  const rs = RoundState.getMutable(roundEntity)

  function reject(reason: string): void {
    console.log(
      `[SERVER] reject ${requestId} player=${playerId.slice(0, 8)} slot=${slotId} ` +
      `reason=${reason} server=${rs.templateId}#${rs.roundNumber}/${currentPhase}`
    )
    ux.emit('attachRejected', {
      requestId, playerId, slotId, reason,
      serverTemplateId: rs.templateId, serverRoundNumber: rs.roundNumber, currentPhase
    })
  }

  if (currentPhase !== 'BUILD') return reject('phase_mismatch')
  if (!templateId || templateId !== rs.templateId) return reject('stale_template')
  if (!roundNumber || roundNumber !== rs.roundNumber) return reject('stale_round')

  const slotIndex = findSlotIndex(rs.templateId, slotId)
  if (slotIndex < 0) return reject('unknown_slot')

  const slotDef = TEMPLATES[rs.templateId as keyof typeof TEMPLATES][slotIndex]
  const requiredPart = slotDef.requiredPart

  const occupiedBit = 1 << slotIndex
  if (((rs.occupiedMask ?? 0) & occupiedBit) !== 0) return reject('slot_occupied')

  if (partType !== requiredPart) {
    ux.emit('wrongPart', {
      slotId, playerId, required: requiredPart,
      templateId: rs.templateId, roundNumber: rs.roundNumber
    })
    return reject('wrong_part')
  }

  rs.occupiedMask = (rs.occupiedMask ?? 0) | occupiedBit
  rs.partsAttached += 1
  rs.stateSeq = (rs.stateSeq || 0) + 1
  slotPlacedBy[slotId] = playerId

  console.log(
    `[SERVER] accept ${requestId} player=${playerId.slice(0, 8)} slot=${slotId} ` +
    `mask=${rs.occupiedMask} parts=${rs.partsAttached}/${rs.partsRequired}`
  )

  if (rs.partsAttached >= rs.partsRequired) enterBuildComplete('perfect')
}

function drainAttachRequests(): void {
  for (const [entity, req] of engine.getEntitiesWith(AttachRequest)) {
    handleAttachRequest(
      req.requestId, req.playerId, req.slotId,
      req.partType, req.templateId, req.roundNumber
    )
    try { engine.removeEntity(entity) } catch (_) {}
  }
}

//  Loop 
function serverTick(dt: number): void {
  if (dt > 0.25) dt = 0.25

  drainAttachRequests()

  if (currentPhase === 'IDLE') return

  timerAccumulator += dt
  if (timerAccumulator < 1) return
  timerAccumulator -= 1

  const timer = GameTimer.getMutable(timerEntity)
  timer.secondsLeft = Math.max(0, timer.secondsLeft - 1)

  bumpSeq()

  if (timer.secondsLeft <= 0) {
    if (currentPhase === 'BUILD') enterBuildComplete('timeout')
    else if (currentPhase === 'BUILD_COMPLETE') enterCountdown()
    else if (currentPhase === 'COUNTDOWN') enterPerform()
    else if (currentPhase === 'PERFORM') enterReset()
    else if (currentPhase === 'RESET') enterBuild()
  }
}
