import {
  engine, Entity, Transform, GltfContainer, MeshCollider, MeshRenderer,
  Material, MaterialTransparencyMode, ColliderLayer,
  InputAction, pointerEventsSystem, Schemas
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { RoundState, ux } from '../shared/components'
import {
  PartType, PART_GLB, GLB_SCALE,
  SCENE_CENTER, DEBUG, RoundPhase
} from '../shared/constants'
import { SlotDefinition, TEMPLATES, TemplateId, getTemplate } from '../shared/templates'
import { getClientSnapshot, requestAttach, getLocalPlayerId } from './client'
import { onWrongPart, showFeedback } from './hud'

//  Slot visual registry 

// One entity per (slotId, kind) for the currently-active round. The
// SlotVisual component tags every entity with its identity so cleanup is
// straightforward when a new round starts.
type SlotKind = 'ghost' | 'hitbox' | 'solid' | 'collider' | 'feedback'

const SlotVisual = engine.defineComponent('dbc:SlotVisual', {
  slotId:      Schemas.String,
  templateId:  Schemas.String,
  roundNumber: Schemas.Int,
  kind:        Schemas.String
})

interface SlotRefs {
  ghost?: Entity
  hitbox?: Entity
  solid?: Entity
  collider?: Entity
}

const slotRefs: Record<string, SlotRefs> = {}
let activeTemplateId: TemplateId | '' = ''
let activeRoundNumber = 0
let lastBoardPhase: RoundPhase = 'IDLE'
let getSelectedPartFn: () => PartType = () => 'CUBE'
let arenaEntity: Entity = 0 as Entity

// Anti-spam: 400ms window after a click to avoid duplicate requests if the
// pointer registers twice. Server dedupes too, but suppressing locally
// keeps logs cleaner.
const recentClicks: Set<string> = new Set()
const ANTI_SPAM_MS = 400

// Active feedback flash entities — tracked so clearAllSlotVisuals can cancel
// them before their setTimeout fires (prevents entity-ID reuse hazards).
const activeFlashes: Set<Entity> = new Set()

// Visual health audit — runs every second in BUILD/BUILD_COMPLETE to catch
// any entities that were silently lost.
let healthAuditAtMs = 0
const HEALTH_AUDIT_INTERVAL_MS = 1000

//  Materials 
const PART_GLOW_COLOR: Record<PartType, Color4> = {
  CUBE:     Color4.create(0.1, 0.3, 1,   0.22),
  CYLINDER: Color4.create(1,   0.1, 0.1, 0.22),
  CONE:     Color4.create(1,   0.85, 0,  0.22)
}

const PART_EMISSIVE: Record<PartType, Color4> = {
  CUBE:     Color4.create(0.1, 0.3, 1, 1),
  CYLINDER: Color4.create(1,   0.1, 0.1, 1),
  CONE:     Color4.create(1,   0.85, 0,  1)
}

function partRotation(part: PartType): Quaternion {
  return part === 'CONE'
    ? Quaternion.fromEulerDegrees(180, 0, 0)
    : Quaternion.Identity()
}

//  Logging 
function logVisualSummary(reason: string): void {
  let total = 0, ghosts = 0, hitboxes = 0, solids = 0, colliders = 0, feedbacks = 0
  for (const [, v] of engine.getEntitiesWith(SlotVisual)) {
    total++
    if (v.kind === 'ghost') ghosts++
    else if (v.kind === 'hitbox') hitboxes++
    else if (v.kind === 'solid') solids++
    else if (v.kind === 'collider') colliders++
    else if (v.kind === 'feedback') feedbacks++
  }
  console.log(
    `[SCENE] visual-summary reason=${reason} template=${activeTemplateId} round=${activeRoundNumber} ` +
    `total=${total} ghosts=${ghosts} hitboxes=${hitboxes} solids=${solids} colliders=${colliders} feedbacks=${feedbacks}`
  )
}

//  Entity helpers 
function isAlive(e: Entity | undefined): boolean {
  if (e === undefined) return false
  try { Transform.get(e); return true } catch (_) { return false }
}

function removeEntitySafe(e: Entity | undefined): void {
  if (e === undefined) return
  try { pointerEventsSystem.removeOnPointerDown(e) } catch (_) {}
  try { engine.removeEntity(e) } catch (_) {}
}

function tagVisual(e: Entity, slot: SlotDefinition, kind: SlotKind): void {
  SlotVisual.createOrReplace(e, {
    slotId: slot.slotId,
    templateId: activeTemplateId,
    roundNumber: activeRoundNumber,
    kind
  })
  if (DEBUG) {
    console.log(`[SCENE] tag kind=${kind} slot=${slot.slotId} template=${activeTemplateId} round=${activeRoundNumber}`)
  }
}

function clearAllSlotVisuals(reason: string): void {
  // Cancel active flashes first to prevent entity-ID reuse after removal.
  for (const e of activeFlashes) removeEntitySafe(e)
  activeFlashes.clear()

  const entities: Entity[] = []
  for (const [e] of engine.getEntitiesWith(SlotVisual)) entities.push(e)
  for (const e of entities) removeEntitySafe(e)
  for (const k of Object.keys(slotRefs)) delete slotRefs[k]
  recentClicks.clear()
  healthAuditAtMs = 0
  if (entities.length > 0) {
    console.log(`[SCENE] cleared ${entities.length} visuals reason=${reason}`)
  }
}

function slotPositionVector(slot: SlotDefinition): Vector3 {
  return Vector3.create(slot.position.x, slot.position.y, slot.position.z)
}

function slotScaleVector(slot: SlotDefinition): Vector3 {
  return Vector3.create(slot.scale.x * GLB_SCALE, slot.scale.y * GLB_SCALE, slot.scale.z * GLB_SCALE)
}

//  Visual builders 
function createGhost(slot: SlotDefinition): Entity {
  const e = engine.addEntity()
  const pos = slotPositionVector(slot)
  const scale = Vector3.scale(slotScaleVector(slot), 1.18)
  Transform.create(e, { position: pos, scale, rotation: partRotation(slot.requiredPart) })
  if (slot.requiredPart === 'CUBE') MeshRenderer.setBox(e)
  else if (slot.requiredPart === 'CYLINDER') MeshRenderer.setCylinder(e)
  else MeshRenderer.setCylinder(e, 0, 0.5)
  Material.setPbrMaterial(e, {
    albedoColor: PART_GLOW_COLOR[slot.requiredPart],
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    emissiveColor: PART_EMISSIVE[slot.requiredPart],
    emissiveIntensity: 1.2
  })
  tagVisual(e, slot, 'ghost')
  return e
}

function createHitbox(slot: SlotDefinition): Entity {
  const e = engine.addEntity()
  Transform.create(e, {
    position: slotPositionVector(slot),
    scale: slotScaleVector(slot),
    rotation: partRotation(slot.requiredPart)
  })
  MeshCollider.setBox(e, ColliderLayer.CL_POINTER)
  pointerEventsSystem.onPointerDown(
    {
      entity: e,
      opts: {
        button: InputAction.IA_POINTER,
        hoverText: 'Click to place piece',
        maxDistance: 8
      }
    },
    () => onSlotClick(slot)
  )
  tagVisual(e, slot, 'hitbox')
  return e
}

function createSolid(slot: SlotDefinition): { solid: Entity; collider: Entity } {
  const solid = engine.addEntity()
  Transform.create(solid, {
    position: slotPositionVector(slot),
    scale: slotScaleVector(slot),
    rotation: partRotation(slot.requiredPart)
  })
  GltfContainer.create(solid, {
    src: PART_GLB[slot.requiredPart],
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  tagVisual(solid, slot, 'solid')

  const collider = engine.addEntity()
  Transform.create(collider, {
    position: slotPositionVector(slot),
    scale: slotScaleVector(slot),
    rotation: partRotation(slot.requiredPart)
  })
  MeshCollider.setBox(collider, ColliderLayer.CL_PHYSICS)
  tagVisual(collider, slot, 'collider')
  return { solid, collider }
}

function flashFeedback(slot: SlotDefinition, color: Color4): void {
  const e = engine.addEntity()
  const scale = Vector3.scale(slotScaleVector(slot), 3.0)
  Transform.create(e, { position: slotPositionVector(slot), scale })
  MeshRenderer.setSphere(e)
  Material.setPbrMaterial(e, {
    albedoColor: { r: color.r, g: color.g, b: color.b, a: 0.55 },
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    emissiveColor: color,
    emissiveIntensity: 3.0
  })
  tagVisual(e, slot, 'feedback')
  activeFlashes.add(e)
  setTimeout(() => {
    activeFlashes.delete(e)
    removeEntitySafe(e)
  }, 600)
}

//  Affordance state 
function ensureSlotAffordance(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId] || (slotRefs[slot.slotId] = {})
  if (!isAlive(refs.ghost)) refs.ghost = createGhost(slot)
  if (!isAlive(refs.hitbox)) refs.hitbox = createHitbox(slot)
}

function removeSlotAffordance(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId]
  if (!refs) return
  removeEntitySafe(refs.ghost)
  removeEntitySafe(refs.hitbox)
  refs.ghost = undefined
  refs.hitbox = undefined
}

function ensureSlotSolid(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId] || (slotRefs[slot.slotId] = {})
  if (!isAlive(refs.solid) || !isAlive(refs.collider)) {
    removeEntitySafe(refs.solid)
    removeEntitySafe(refs.collider)
    const created = createSolid(slot)
    refs.solid = created.solid
    refs.collider = created.collider
  }
}

function removeSlotSolid(slot: SlotDefinition): void {
  const refs = slotRefs[slot.slotId]
  if (!refs) return
  removeEntitySafe(refs.solid)
  removeEntitySafe(refs.collider)
  refs.solid = undefined
  refs.collider = undefined
}

//  Arena 
export function clearAllVisuals(reason: string): void {
  clearAllSlotVisuals(reason)
}

export function initArena(): void {
  if (arenaEntity !== (0 as Entity)) return
  arenaEntity = engine.addEntity()
  Transform.create(arenaEntity, {
    position: Vector3.create(SCENE_CENTER.x, SCENE_CENTER.y, SCENE_CENTER.z),
    rotation: Quaternion.Identity(),
    scale: Vector3.One()
  })
  GltfContainer.create(arenaEntity, {
    src: 'assets/scene/Models/DBC/DBCPLATAFORMA_20260429.glb',
    visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS,
    invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS
  })
}

//  Public init 
export function initScene(getPart: () => PartType): void {
  getSelectedPartFn = getPart

  ux.on('wrongPart', (data: any) => {
    if (!data) return
    const snap = getClientSnapshot()
    if (!snap.resolved) return
    if (data.templateId !== snap.templateId || data.roundNumber !== snap.roundNumber) return
    if (data.playerId !== getLocalPlayerId()) return
    const slots = getTemplate(snap.templateId)
    const slot = slots?.find(s => s.slotId === data.slotId)
    if (slot) flashFeedback(slot, Color4.create(1, 0.1, 0.1, 1))
    onWrongPart(data.required as PartType)
  })

  ux.on('attachRejected', (data: any) => {
    if (!data || data.playerId !== getLocalPlayerId()) return
    clearAntiSpam(data.slotId)
    console.log(`[SCENE] rejected reason=${data.reason} slot=${data.slotId} phase=${data.currentPhase}`)
  })
}

//  Visual health audit 
// Runs once per second. Verifies slotRefs match the expected state and
// silently repairs any discrepancy (e.g. an entity whose underlying ECS
// record was silently dropped). Repairs are logged only when N > 0.
function runHealthAudit(slots: SlotDefinition[], mask: number, phase: string): void {
  let repaired = 0
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const occupied = ((mask >> i) & 1) === 1
    const refs = slotRefs[slot.slotId] || (slotRefs[slot.slotId] = {})

    if (occupied) {
      if (!isAlive(refs.solid) || !isAlive(refs.collider)) {
        removeEntitySafe(refs.solid)
        removeEntitySafe(refs.collider)
        const created = createSolid(slot)
        refs.solid = created.solid
        refs.collider = created.collider
        repaired++
      }
      if (isAlive(refs.ghost))  { removeEntitySafe(refs.ghost);  refs.ghost  = undefined; repaired++ }
      if (isAlive(refs.hitbox)) { removeEntitySafe(refs.hitbox); refs.hitbox = undefined; repaired++ }
    } else if (phase === 'BUILD') {
      if (!isAlive(refs.ghost) || !isAlive(refs.hitbox)) {
        removeEntitySafe(refs.ghost)
        removeEntitySafe(refs.hitbox)
        refs.ghost  = createGhost(slot)
        refs.hitbox = createHitbox(slot)
        repaired++
      }
      if (isAlive(refs.solid))    { removeEntitySafe(refs.solid);    refs.solid    = undefined; repaired++ }
      if (isAlive(refs.collider)) { removeEntitySafe(refs.collider); refs.collider = undefined; repaired++ }
    }
  }
  if (repaired > 0) console.log(`[VISUAL-HEALTH] repaired=${repaired}`)
}

//  Reconciliation 
// Runs every frame. Diffs the authoritative state against the local visuals
// and applies the minimum number of mutations to converge. Idempotent.
export function reconcileScene(): void {
  const snap = getClientSnapshot()

  // Out-of-sync or paused: tear everything down and wait.
  if (!snap.resolved || snap.isStale || snap.phase === 'IDLE') {
    if (Object.keys(slotRefs).length > 0) {
      clearAllSlotVisuals(snap.isStale ? 'stale' : (snap.resolved ? 'idle' : 'unresolved'))
      activeTemplateId = ''
      activeRoundNumber = 0
      lastBoardPhase = snap.phase
    }
    return
  }

  const phase = snap.phase
  const templateId = snap.templateId
  const slots = getTemplate(templateId)
  if (!slots) return

  // Round/template change: wipe and rebuild.
  const phaseRebuild = phase !== lastBoardPhase
  if (templateId !== activeTemplateId || snap.roundNumber !== activeRoundNumber) {
    clearAllSlotVisuals(`rebuild template=${templateId} round=${snap.roundNumber}`)
    activeTemplateId = templateId as TemplateId
    activeRoundNumber = snap.roundNumber
  }
  lastBoardPhase = phase

  const buildable = phase === 'BUILD'
  const showSolids = phase === 'BUILD' || phase === 'BUILD_COMPLETE'

  // On transition into a non-visual phase, declaratively remove all slot
  // entities. Per-slot removeSlotSolid/removeSlotAffordance depend on slotRefs
  // being fully populated, which is not guaranteed for late joiners whose initial
  // state came from a CRDT snapshot rather than incremental attach events.
  if (phaseRebuild && !showSolids) {
    clearAllSlotVisuals(`transition-to=${phase}`)
  }

  // Build occupiedMask from authoritative state.
  const mask = snap.occupiedMask | 0
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const occupied = ((mask >> i) & 1) === 1

    if (occupied) {
      removeSlotAffordance(slot)
      if (showSolids) ensureSlotSolid(slot)
      else removeSlotSolid(slot)
    } else {
      removeSlotSolid(slot)
      if (buildable) ensureSlotAffordance(slot)
      else removeSlotAffordance(slot)
    }
  }

  if (phaseRebuild) logVisualSummary(`phase=${phase}`)

  // Periodic health audit — verify slotRefs state every second.
  if (phase === 'BUILD' || phase === 'BUILD_COMPLETE') {
    const now = Date.now()
    if (now - healthAuditAtMs >= HEALTH_AUDIT_INTERVAL_MS) {
      healthAuditAtMs = now
      runHealthAudit(slots, mask, phase)
    }
  }
}

//  Click handler 
function clearAntiSpam(slotId: string): void {
  recentClicks.delete(slotId)
}

function onSlotClick(slot: SlotDefinition): void {
  const snap = getClientSnapshot()
  if (!snap.resolved) {
    showFeedback('Connecting...')
    return
  }
  if (snap.isStale) {
    showFeedback('Syncing...')
    return
  }
  if (snap.phase !== 'BUILD') return
  if (snap.templateId !== activeTemplateId || snap.roundNumber !== activeRoundNumber) return
  if (recentClicks.has(slot.slotId)) return

  const slots = TEMPLATES[snap.templateId as TemplateId]
  if (!slots) return
  const idx = slots.findIndex(s => s.slotId === slot.slotId)
  if (idx < 0) return
  if (((snap.occupiedMask >> idx) & 1) === 1) {
    showFeedback('Slot already taken')
    return
  }

  const selected = getSelectedPartFn()
  if (selected !== slot.requiredPart) {
    flashFeedback(slot, Color4.create(1, 0.1, 0.1, 1))
    onWrongPart(slot.requiredPart)
    return
  }

  recentClicks.add(slot.slotId)
  setTimeout(() => recentClicks.delete(slot.slotId), ANTI_SPAM_MS)
  flashFeedback(slot, Color4.create(1, 1, 0.5, 1))

  requestAttach(slot.slotId, selected)
}
