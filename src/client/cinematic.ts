import { VirtualCamera, MainCamera, Transform, engine } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { getClientSnapshot } from './client'
import { setCarriedVisible, setCinematicCameraActive } from './hud'
import {
  COUNTDOWN_SECONDS,
  PERFORMANCE_DURATION_SECONDS,
  RESET_DELAY_SECONDS,
  CINEMATIC_WATCHDOG_GRACE_SECONDS,
  SCENE_CENTER,
  RoundPhase
} from '../shared/constants'

// Full expected duration of the inter-round window, plus grace.
const WATCHDOG_SECONDS =
  COUNTDOWN_SECONDS + PERFORMANCE_DURATION_SECONDS + RESET_DELAY_SECONDS +
  CINEMATIC_WATCHDOG_GRACE_SECONDS

interface Shot {
  startPos: { x: number; y: number; z: number }
  endPos:   { x: number; y: number; z: number }
  pitch: number
  yaw:   number
}

// Six camera angles that dolly toward the build area.
const SHOTS: Shot[] = [
  { startPos: { x: SCENE_CENTER.x,     y: 13, z: SCENE_CENTER.z + 11 }, endPos: { x: SCENE_CENTER.x,     y: 9,  z: SCENE_CENTER.z + 5 }, pitch: 25, yaw: 180 },
  { startPos: { x: SCENE_CENTER.x,     y: 12, z: SCENE_CENTER.z - 11 }, endPos: { x: SCENE_CENTER.x,     y: 8,  z: SCENE_CENTER.z - 4 }, pitch: 22, yaw: 0 },
  { startPos: { x: SCENE_CENTER.x + 11,y: 12, z: SCENE_CENTER.z      }, endPos: { x: SCENE_CENTER.x + 5, y: 9,  z: SCENE_CENTER.z     }, pitch: 22, yaw: 270 },
  { startPos: { x: SCENE_CENTER.x - 11,y: 12, z: SCENE_CENTER.z      }, endPos: { x: SCENE_CENTER.x - 5, y: 9,  z: SCENE_CENTER.z     }, pitch: 22, yaw: 90 },
  { startPos: { x: SCENE_CENTER.x,     y: 20, z: SCENE_CENTER.z + 8  }, endPos: { x: SCENE_CENTER.x,     y: 14, z: SCENE_CENTER.z + 3 }, pitch: 55, yaw: 180 },
  { startPos: { x: SCENE_CENTER.x + 8, y: 13, z: SCENE_CENTER.z + 8  }, endPos: { x: SCENE_CENTER.x + 4, y: 9,  z: SCENE_CENTER.z + 4 }, pitch: 28, yaw: 225 },
]
const DOLLY_DURATION = 10 // seconds

// Lazy + guarded: creating the VirtualCamera at module load crashed the
// whole bundle on explorers without virtual-camera support (mobile) — the
// scene loaded but no code ran. Created on first use; null means "this
// client can't do cinematic cameras" and the letterbox stays off.
let camEntity: ReturnType<typeof engine.addEntity> | null = null
let camFailed = false

function getCamEntity(): ReturnType<typeof engine.addEntity> | null {
  if (camEntity !== null || camFailed) return camEntity
  try {
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(SHOTS[0].startPos.x, SHOTS[0].startPos.y, SHOTS[0].startPos.z),
      rotation: Quaternion.fromEulerDegrees(SHOTS[0].pitch, SHOTS[0].yaw, 0)
    })
    VirtualCamera.create(e, {
      defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0) }
    })
    camEntity = e
  } catch (err) {
    camFailed = true
    console.log(`[CINEMATIC] VirtualCamera unavailable: ${err}`)
  }
  return camEntity
}

let lastPhase: RoundPhase = 'IDLE'
let cinematicActive = false
let cameraEngaged = false
let cameraProbed = false
let elapsed = 0
let shotIndex = 0
let currentShot: Shot = SHOTS[0]
let cinematicStartRound = 0
let initialized = false

function activateCinematic(round: number): void {
  currentShot = SHOTS[shotIndex % SHOTS.length]
  shotIndex++
  elapsed = 0
  cinematicActive = true
  cinematicStartRound = round
  cameraProbed = false
  setCarriedVisible(false)

  const cam = getCamEntity()
  if (cam !== null) {
    try {
      const t = Transform.getMutable(cam)
      t.position = Vector3.create(currentShot.startPos.x, currentShot.startPos.y, currentShot.startPos.z)
      t.rotation = Quaternion.fromEulerDegrees(currentShot.pitch, currentShot.yaw, 0)
      MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cam })
      cameraEngaged = true
    } catch (err) {
      cameraEngaged = false
      console.log(`[CINEMATIC] MainCamera assign FAILED: ${err}`)
    }
  } else {
    cameraEngaged = false
  }
  // Letterbox must follow the real camera state, never the phase alone.
  setCinematicCameraActive(cameraEngaged)
  console.log(`[CINEMATIC] start round=${round} shot=${shotIndex - 1} engaged=${cameraEngaged}`)
}

function releaseCinematic(reason: string): void {
  if (!cinematicActive) return
  cinematicActive = false
  cameraEngaged = false
  setCinematicCameraActive(false)
  try {
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  } catch (err) {
    console.log(`[CINEMATIC] MainCamera release FAILED: ${err}`)
  }
  console.log(`[CINEMATIC] release reason=${reason} elapsed=${elapsed.toFixed(1)}s`)
}

export function cinematicSystem(dt: number): void {
  if (!initialized) {
    initialized = true
    try {
      MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
    } catch (_) {}
  }

  const snap = getClientSnapshot()
  const phase = snap.phase

  // Stale client — immediately release the camera so the player isn't trapped.
  if (snap.isStale) {
    if (cinematicActive) releaseCinematic('stale_crdt')
    return
  }

  // Phase transition handling.
  if (phase !== lastPhase) {
    lastPhase = phase

    if (phase === 'COUNTDOWN') {
      // reconcileScene (priority 3) has already cleared visuals this frame.
      setCarriedVisible(false)
      activateCinematic(snap.roundNumber)
    } else if (phase === 'PERFORM' || phase === 'RESET') {
      // Late joiners land here without having gone through COUNTDOWN;
      // start the cinematic now. The watchdog releases it when the round advances.
      if (!cinematicActive) {
        setCarriedVisible(false)
        activateCinematic(snap.roundNumber)
      }
    } else if (phase === 'BUILD' || phase === 'IDLE') {
      releaseCinematic('phase_build')
      setCarriedVisible(true)
    }
  }

  if (!cinematicActive) return

  elapsed += dt

  // One-shot probe ~1s into the shot: compare the actual render camera
  // position against the virtual camera. dist≈0 means the explorer honored
  // the VirtualCamera; a large dist means it was silently ignored and the
  // player is still in first/third person.
  if (!cameraProbed && elapsed >= 1) {
    cameraProbed = true
    try {
      const camE = getCamEntity()
      if (camE === null) throw new Error('no virtual camera')
      const cam = Transform.get(engine.CameraEntity).position
      const virt = Transform.get(camE).position
      const dx = cam.x - virt.x
      const dy = cam.y - virt.y
      const dz = cam.z - virt.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      console.log(
        `[CINEMATIC] probe dist=${dist.toFixed(2)} honored=${dist < 2} ` +
        `cam=(${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.z.toFixed(1)}) ` +
        `virt=(${virt.x.toFixed(1)},${virt.y.toFixed(1)},${virt.z.toFixed(1)})`
      )
    } catch (err) {
      console.log(`[CINEMATIC] probe FAILED: ${err}`)
    }
  }

  // Watchdog A: server has moved on to a new round.
  // Watchdog B: hard elapsed limit.
  if (snap.roundNumber > cinematicStartRound || elapsed >= WATCHDOG_SECONDS) {
    const reason = snap.roundNumber > cinematicStartRound ? 'round_advanced' : 'watchdog_timeout'
    releaseCinematic(reason)
    return
  }

  // Dolly the camera forward over DOLLY_DURATION seconds.
  const progress = Math.min(elapsed / DOLLY_DURATION, 1)
  try {
    const camE = getCamEntity()
    if (camE === null) return
    const t = Transform.getMutable(camE)
    t.position = Vector3.create(
      currentShot.startPos.x + (currentShot.endPos.x - currentShot.startPos.x) * progress,
      currentShot.startPos.y + (currentShot.endPos.y - currentShot.startPos.y) * progress,
      currentShot.startPos.z + (currentShot.endPos.z - currentShot.startPos.z) * progress
    )
  } catch (_) {}
}
