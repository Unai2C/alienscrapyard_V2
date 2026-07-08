import {
  engine, Entity, Transform, GltfContainer, AudioSource,
  InputAction, inputSystem, PointerEventType, UiCanvasInformation
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { ReactEcsRenderer, UiEntity, Label, ReactEcs } from '@dcl/sdk/react-ecs'
import {
  PART_TYPES, PART_GLB, PART_LABEL, PART_SYMBOL, PartType,
  SCENE_CENTER, PERFORMANCE_LABEL, RoundPhase,
  COUNTDOWN_SECONDS, PERFORMANCE_DURATION_SECONDS, RESET_DELAY_SECONDS
} from '../shared/constants'
import { getClientSnapshot } from './client'
import { getIsMobile } from './platform'

let selectedIndex = 0
// One persistent entity per piece type, each with its GLB loaded once at
// init. Cycling pieces only toggles which one is visible (scale) — the GLB
// src is never swapped on a live entity, which the Unity renderer fails to
// reinstantiate (the same churn that broke slot visuals).
const shoulderEntities: Entity[] = []
const SHOULDER_SCALE = 0.272
let carriedVisible = true
let cinematicCameraActive = false
let feedbackText = ''
let feedbackTimer = 0
let showOnboarding = true
let onboardingAlpha = 1
let onboardingDismissed = false
let floatTime = 0
let ambientEntity: Entity = 0 as Entity

const FEEDBACK_DURATION = 2.5

//  Public API 
export function getSelectedPart(): PartType {
  return PART_TYPES[selectedIndex]
}

export function showFeedback(text: string): void {
  feedbackText = text
  feedbackTimer = FEEDBACK_DURATION
}

export function onWrongPart(required: PartType): void {
  showFeedback(`Wrong piece — need ${PART_LABEL[required]}`)
  playWrong()
}

export function dismissOnboarding(): void {
  if (!onboardingDismissed) onboardingDismissed = true
}

// Set by cinematic.ts with the REAL camera state — true only when the
// VirtualCamera assignment succeeded. The letterbox keys off this, so a
// client whose explorer rejects the virtual camera keeps its normal view
// instead of getting black bars over first person.
export function setCinematicCameraActive(active: boolean): void {
  cinematicCameraActive = active
}

// Total seconds left in the whole inter-round cinematic window (COUNTDOWN +
// PERFORM + RESET), counted down as one continuous number (~7 → 0).
function cinematicSecondsLeft(phase: RoundPhase, secondsLeftInPhase: number): number {
  if (phase === 'COUNTDOWN') return secondsLeftInPhase + PERFORMANCE_DURATION_SECONDS + RESET_DELAY_SECONDS
  if (phase === 'PERFORM')   return secondsLeftInPhase + RESET_DELAY_SECONDS
  if (phase === 'RESET')     return secondsLeftInPhase
  return 0
}

//  Audio
// One-shot SFX use a small round-robin pool of "voice" entities. A single
// AudioSource can only voice one instance at a time, so two rapid clicks on
// the same entity just restart the sound — you never hear both. Cycling
// through N voices lets back-to-back plays overlap. All voices are created
// once at init; gameplay only retriggers them (zero entity churn).
const SFX_VOICES = 3
const successVoices: Entity[] = []
const pressVoices: Entity[] = []
const wrongVoices: Entity[] = []
let successCursor = 0
let pressCursor = 0
let wrongCursor = 0

function createVoiceEntity(): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(SCENE_CENTER.x, SCENE_CENTER.y + 1, SCENE_CENTER.z) })
  return e
}

function playVoice(voices: Entity[], cursor: number, url: string, volume: number): number {
  if (voices.length === 0) return cursor
  try {
    AudioSource.createOrReplace(voices[cursor], { audioClipUrl: url, playing: true, loop: false, volume })
  } catch (_) {}
  return (cursor + 1) % voices.length
}

export function playSuccess(): void {
  successCursor = playVoice(successVoices, successCursor, 'assets/sounds/success.mp3', 1.0)
}

export function playWrong(): void {
  wrongCursor = playVoice(wrongVoices, wrongCursor, 'assets/sounds/wrong.mp3', 1.0)
}

function playPress(): void {
  pressCursor = playVoice(pressVoices, pressCursor, 'assets/sounds/pressE.mp3', 1.0)
}

function initAudio(): void {
  if (ambientEntity !== (0 as Entity)) return
  for (let i = 0; i < SFX_VOICES; i++) {
    successVoices.push(createVoiceEntity())
    pressVoices.push(createVoiceEntity())
    wrongVoices.push(createVoiceEntity())
  }
  ambientEntity = engine.addEntity()
  Transform.create(ambientEntity, { position: Vector3.create(SCENE_CENTER.x, SCENE_CENTER.y + 1, SCENE_CENTER.z) })
  AudioSource.create(ambientEntity, {
    audioClipUrl: 'assets/sounds/ambient.mp3',
    playing: true,
    loop: true,
    volume: 0.06,
    global: true
  })
}

//  Shoulder carried piece
export function initShoulder(playerEntity: Entity): void {
  if (shoulderEntities.length > 0) return
  for (let i = 0; i < PART_TYPES.length; i++) {
    const e = engine.addEntity()
    const show = carriedVisible && i === selectedIndex
    Transform.create(e, {
      position: Vector3.create(0.5, 1.5, -0.5),
      scale: show ? Vector3.create(SHOULDER_SCALE, SHOULDER_SCALE, SHOULDER_SCALE) : Vector3.Zero(),
      rotation: Quaternion.Identity(),
      parent: playerEntity
    })
    GltfContainer.create(e, { src: PART_GLB[PART_TYPES[i]] })
    shoulderEntities.push(e)
  }
}

function applyShoulderVisibility(): void {
  for (let i = 0; i < shoulderEntities.length; i++) {
    const show = carriedVisible && i === selectedIndex
    try {
      Transform.getMutable(shoulderEntities[i]).scale = show
        ? Vector3.create(SHOULDER_SCALE, SHOULDER_SCALE, SHOULDER_SCALE)
        : Vector3.Zero()
    } catch (_) {}
  }
}

export function setCarriedVisible(visible: boolean): void {
  carriedVisible = visible
  applyShoulderVisibility()
}

function updateShoulderPiece(): void {
  applyShoulderVisibility()
}

//  Input 
export function hudInputSystem(_dt: number): void {
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
    selectedIndex = (selectedIndex + 1) % PART_TYPES.length
    updateShoulderPiece()
    playPress()
    dismissOnboarding()
  }
}

//  Per-frame ticks
let lastHudPhase: RoundPhase = 'IDLE'
let blueFlashAlpha = 0
let blueFlashFired = false

export function hudTickSystem(dt: number): void {
  // Feedback messages are BUILD-phase interaction hints; drop them on any
  // phase change so they never overlap the cinematic letterbox.
  const snap = getClientSnapshot()
  const phase = snap.phase
  const prevPhase = lastHudPhase  // save BEFORE updating, needed for transition checks
  if (phase !== lastHudPhase) {
    lastHudPhase = phase
    feedbackText = ''
    feedbackTimer = 0
  }

  if (feedbackTimer > 0) {
    feedbackTimer = Math.max(0, feedbackTimer - dt)
    if (feedbackTimer <= 0) feedbackText = ''
  }
  if (onboardingDismissed && onboardingAlpha > 0) {
    onboardingAlpha = Math.max(0, onboardingAlpha - dt * 1.8)
    if (onboardingAlpha <= 0) showOnboarding = false
  }

  // Cyan system-failure flash: instant burst at the explosion, re-triggers at the
  // BUILD transition to cover the cinematic→first-person camera switch.
  if (phase === 'COUNTDOWN' && prevPhase !== 'COUNTDOWN') {
    blueFlashFired = false  // reset each round so the flash fires every cinematic
  }
  if (!blueFlashFired && phase === 'RESET' && snap.secondsLeft <= 1) {
    blueFlashFired = true
    blueFlashAlpha = 1.0
  }
  if (phase === 'BUILD' && prevPhase !== 'BUILD') {
    blueFlashAlpha = 1.0  // re-fire to cover camera switch back to first-person
  }
  if (blueFlashAlpha > 0) {
    blueFlashAlpha = Math.max(0, blueFlashAlpha - dt * 16) // ~62ms each burst
  }

  floatTime += dt
  const shoulderY = 1.5 + Math.sin(floatTime * 2.5) * 0.06
  for (const e of shoulderEntities) {
    try {
      Transform.getMutable(e).position = Vector3.create(0.5, shoulderY, -0.5)
    } catch (_) {}
  }
}

//  UI 
const PART_UI_COLOR: Record<PartType, { r: number; g: number; b: number; a: number }> = {
  CUBE:     { r: 0.2, g: 0.5, b: 1,    a: 1 },
  CYLINDER: { r: 1,   g: 0.2, b: 0.2,  a: 1 },
  CONE:     { r: 1,   g: 0.85, b: 0,   a: 1 }
}

function phaseLabel(phase: RoundPhase, snap: ReturnType<typeof getClientSnapshot>): string {
  switch (phase) {
    case 'BUILD':          return `BUILD THE ${snap.templateId} — ${snap.secondsLeft}s`
    case 'BUILD_COMPLETE': return snap.performanceType === 'PERFECT' ? PERFORMANCE_LABEL.PERFECT : PERFORMANCE_LABEL.FAIL
    case 'COUNTDOWN':      return `GET READY... ${snap.secondsLeft}`
    case 'PERFORM':        return snap.performanceType === 'PERFECT' ? PERFORMANCE_LABEL.PERFECT : PERFORMANCE_LABEL.FAIL
    case 'RESET':          return 'NEXT ROUND...'
    default:               return 'WAITING...'
  }
}

export function initHUD(): void {
  initAudio()

  ReactEcsRenderer.setUiRenderer(() => {
    const snap = getClientSnapshot()
    const phase = snap.phase
    const inBuild = phase === 'BUILD' && !snap.isStale
    // Letterbox only while the cinematic camera is genuinely driving the view.
    const inCinematic = cinematicCameraActive && !snap.isStale
    const syncing = !snap.resolved || snap.isStale

    const partsRequired = Math.max(1, snap.partsRequired)
    const pct = Math.round((snap.partsAttached / partsRequired) * 100)
    const isUrgent = inBuild && snap.secondsLeft <= 10
    const label = syncing
      ? 'Syncing with server...'
      : phaseLabel(phase, snap)

    // Real canvas size, in UI logical pixels. Every element is laid out
    // against these values each frame, so the HUD tracks resolution and
    // window-size changes live — fixed 1920×1080 coordinates put the bottom
    // letterbox bar mid-screen on any non-16:9 display.
    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    const dpr = canvas?.devicePixelRatio || 1
    const sw = canvas && canvas.width > 0 ? canvas.width / dpr : 1920
    const sh = canvas && canvas.height > 0 ? canvas.height / dpr : 1080
    // Uniform scale for element sizes; fonts get a floor so text stays
    // readable on small (mobile) screens. Per the official mobile guide,
    // touch UIs must be sized up (they suggest ~3× for dense desktop UIs;
    // ours is already large, 1.6× lands on comparable physical sizes) and
    // critical UI must live inside the safe area: the system HUD reserves
    // 30% left, 25% right and 8% top/bottom of the screen for controls.
    const mob = getIsMobile()
    const mul = mob ? 1.6 : 1
    const s = Math.min(sw / 1920, sh / 1080)
    const fscale = Math.max(s * mul, 0.62)
    const px = (n: number) => Math.round(n * s)
    const pxm = (n: number) => Math.round(n * s * mul)
    const fpx = (n: number) => Math.round(n * fscale)
    // Centered on the safe band (x 0.30–0.75) on mobile, true center on desktop.
    const cx = (w: number) => Math.round((mob ? sw * 0.525 : sw / 2) - w / 2)
    // Push the top HUD stack below the reserved top 8% on mobile.
    const hudTop = mob ? Math.round(sh * 0.08) : 0
    // Width clamps so scaled-up bars never invade the joystick/buttons zones.
    const topBarW = mob ? Math.min(pxm(960), Math.round(sw * 0.5)) : px(960)
    const progW   = mob ? Math.min(pxm(768), Math.round(sw * 0.45)) : px(768)
    const pickerW = mob ? Math.min(pxm(440), Math.round(sw * 0.45)) : px(440)
    // Letterbox bars: ~13% of the real screen height, top and bottom.
    const barH = Math.round(sh * 0.13)
    const innerH = sh - barH * 2

    return (
      <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}>

        {/* Top bar — phase / timer / syncing */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: hudTop + pxm(12), left: cx(topBarW) },
            width: topBarW, height: pxm(38),
            alignItems: 'center',
            justifyContent: 'center'
          }}
          uiBackground={{
            color: syncing
              ? { r: 0.25, g: 0.15, b: 0.05, a: 0.92 }
              : { r: 0.05, g: 0.05, b: 0.18, a: 0.92 }
          }}
        >
          <Label
            value={label}
            fontSize={isUrgent ? fpx(18) : fpx(15)}
            color={{
              r: 1,
              g: isUrgent ? 0.3 : (syncing ? 0.8 : 1),
              b: isUrgent ? 0.3 : (syncing ? 0.4 : 1),
              a: 1
            }}
            uiTransform={{ width: '100%', height: '100%' }}
            textAlign='middle-center'
          />
        </UiEntity>

        {/* All conditional blocks below stay permanently mounted and toggle
            via display — unmount/remount churn of UI entities desyncs the
            Unity renderer (icons/text dropped or ghosted). */}

        {/* Progress bar */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: hudTop + pxm(60), left: cx(progW) }, width: progW, height: pxm(14), display: inBuild ? 'flex' : 'none' }}
          uiBackground={{ color: { r: 0.1, g: 0.1, b: 0.1, a: 0.7 } }}
        >
          <UiEntity
            uiTransform={{ width: `${pct}%`, height: pxm(14) }}
            uiBackground={{ color: { r: 0.15, g: 0.75, b: 0.3, a: 1 } }}
          />
        </UiEntity>

        {/* Progress label */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: hudTop + pxm(78), left: cx(progW) }, width: progW, height: pxm(20), alignItems: 'center', justifyContent: 'center', display: inBuild ? 'flex' : 'none' }}
        >
          <Label
            value={`${snap.partsAttached} / ${snap.partsRequired}`}
            fontSize={fpx(12)}
            color={{ r: 0.85, g: 0.85, b: 1, a: 1 }}
            uiTransform={{ width: '100%', height: '100%' }}
            textAlign='middle-center'
          />
        </UiEntity>

        {/* Piece picker */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: hudTop + pxm(110), left: cx(pickerW) },
            width: pickerW, height: pxm(104),
            flexDirection: 'column',
            alignItems: 'center',
            display: inBuild ? 'flex' : 'none'
          }}
          uiBackground={{ color: { r: 0.05, g: 0.05, b: 0.2, a: 0.88 } }}
        >
            <Label
              value='CURRENT BLOCK'
              fontSize={fpx(10)}
              color={{ r: 0.5, g: 0.5, b: 0.9, a: 0.9 }}
              uiTransform={{ width: '100%', height: pxm(20) }}
              textAlign='middle-center'
            />
            <UiEntity
              uiTransform={{ width: '100%', height: pxm(56), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}
            >
              {PART_TYPES.map(pt => {
                const isSelected = pt === PART_TYPES[selectedIndex]
                const col = PART_UI_COLOR[pt]
                const tint = isSelected
                  ? col
                  : { r: col.r * 0.5, g: col.g * 0.5, b: col.b * 0.5, a: 0.6 }
                return (
                  <UiEntity
                    key={pt}
                    uiTransform={{ width: pxm(60), height: pxm(48), alignItems: 'center', justifyContent: 'center' }}
                    uiBackground={{ color: isSelected
                      ? { r: 0.12, g: 0.12, b: 0.45, a: 1 }
                      : { r: 0.02, g: 0.02, b: 0.1, a: 0.8 }
                    }}
                  >
                    <Label
                      value={PART_SYMBOL[pt]}
                      fontSize={pt === 'CYLINDER' ? fpx(32) : fpx(28)}
                      color={tint}
                      uiTransform={{ width: '100%', height: '100%' }}
                      textAlign='middle-center'
                    />
                  </UiEntity>
                )
              })}
            </UiEntity>
            <Label
              value='Press <color=#00ffff><size=14>E</size></color> to change block'
              fontSize={fpx(9)}
              color={{ r: 0.6, g: 0.6, b: 0.8, a: 0.85 }}
              uiTransform={{ width: '100%', height: pxm(18) }}
              textAlign='middle-center'
            />
        </UiEntity>

        {/* Feedback — bottom bar (anchored to the real bottom edge) */}
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: mob ? Math.round(sh * 0.92) - pxm(38) : sh - px(60), left: cx(topBarW) }, width: topBarW, height: pxm(38), alignItems: 'center', justifyContent: 'center', display: feedbackText !== '' ? 'flex' : 'none' }}
          uiBackground={{ color: { r: 0.05, g: 0.05, b: 0.2, a: 0.88 } }}
        >
          <Label
            value={feedbackText}
            fontSize={fpx(14)}
            color={{ r: 1, g: 1, b: 1, a: 1 }}
            uiTransform={{ width: '100%', height: '100%' }}
            textAlign='middle-center'
          />
        </UiEntity>

        {/* Onboarding */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: Math.round(sh * 0.26), left: cx(mob ? Math.round(sw * 0.5) : px(960)) },
            width: mob ? Math.round(sw * 0.5) : px(960),
            flexDirection: 'column',
            alignItems: 'center',
            display: showOnboarding && !inCinematic && !syncing ? 'flex' : 'none'
          }}
          uiBackground={{ color: { r: 0.03, g: 0.03, b: 0.15, a: 0.95 * onboardingAlpha } }}
        >
            <Label
              value='ALIENSCRAPYARD'
              fontSize={fpx(42)}
              color={{ r: 0, g: 1, b: 1, a: onboardingAlpha }}
              uiTransform={{ width: '100%', height: pxm(60) }}
              textAlign='middle-center'
            />
            <Label
              value='Place the matching pieces before the timer runs out.'
              fontSize={fpx(20)}
              color={{ r: 0.9, g: 0.9, b: 1, a: onboardingAlpha }}
              uiTransform={{ width: '100%', height: pxm(32) }}
              textAlign='middle-center'
            />
            <Label
              value='Press <color=#00ffff><size=22>E</size></color> to change piece. Click a slot to place.'
              fontSize={fpx(16)}
              color={{ r: 0.9, g: 0.9, b: 1, a: onboardingAlpha }}
              uiTransform={{ width: '100%', height: pxm(28) }}
              textAlign='middle-center'
            />
            <Label value=' ' fontSize={6} color={{ r: 0, g: 0, b: 0, a: 0 }} uiTransform={{ width: '100%', height: pxm(10) }} textAlign='middle-center' />
        </UiEntity>

        {/* PERFECT / FAIL overlay — centrado grande durante BUILD_COMPLETE */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: Math.round((sh - pxm(220)) / 2), left: cx(mob ? Math.round(sw * 0.6) : px(1280)) },
            width: mob ? Math.round(sw * 0.6) : px(1280), height: pxm(220),
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            display: phase === 'BUILD_COMPLETE' && snap.resolved && !snap.isStale ? 'flex' : 'none'
          }}
          uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.72 } }}
        >
          <Label
            value={snap.performanceType === 'PERFECT' ? 'PERFECT BUILD!' : 'INCOMPLETE'}
            fontSize={fpx(80)}
            color={snap.performanceType === 'PERFECT'
              ? { r: 0, g: 1, b: 1, a: 1 }
              : { r: 1, g: 0.25, b: 0.15, a: 1 }}
            uiTransform={{ width: '100%', height: pxm(160) }}
            textAlign='middle-center'
          />
          <Label
            value={snap.performanceType === 'PERFECT' ? `${snap.partsAttached} / ${snap.partsRequired} pieces placed` : `${snap.partsAttached} / ${snap.partsRequired} pieces placed`}
            fontSize={fpx(22)}
            color={{ r: 0.8, g: 0.8, b: 0.9, a: 0.85 }}
            uiTransform={{ width: '100%', height: pxm(40) }}
            textAlign='middle-center'
          />
        </UiEntity>

        {/* Cinematic letterbox + countdown + effects */}
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', display: inCinematic ? 'flex' : 'none' }}>

          {/* Top + bottom letterbox bars — anchored to the REAL screen edges */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: barH }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 1 } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: sh - barH, left: 0 }, width: '100%', height: barH }}
            uiBackground={{ color: { r: 0, g: 0, b: 0, a: 1 } }}
          />

          {/* Inner edge glow — top + bottom */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: barH - px(4), left: 0 }, width: '100%', height: px(4) }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: 0.5 + Math.sin(floatTime * 2.2) * 0.3 } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: sh - barH, left: 0 }, width: '100%', height: px(4) }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: 0.5 + Math.sin(floatTime * 2.2 + 1.5) * 0.3 } }}
          />

          {/* Left + right accent bars pulsing (offset phase) */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: barH, left: 0 }, width: px(4), height: innerH }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: Math.max(0.1, 0.4 + Math.sin(floatTime * 2.5) * 0.4) } }}
          />
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: barH, left: sw - px(4) }, width: px(4), height: innerH }}
            uiBackground={{ color: { r: 0.3, g: 0.6, b: 1, a: Math.max(0.1, 0.4 + Math.sin(floatTime * 2.5 + Math.PI) * 0.4) } }}
          />

          {/* Moving scan line */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: Math.round(barH + ((Math.sin(floatTime * 0.75) + 1) / 2) * (innerH - px(3))), left: 0 },
              width: '100%', height: px(3)
            }}
            uiBackground={{ color: { r: 0.5, g: 0.8, b: 1, a: 0.45 } }}
          />

          {/* "NEXT BUILD IN" label */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: barH + pxm(22), left: 0 }, width: '100%', height: pxm(58), alignItems: 'center', justifyContent: 'center' }}
          >
            <Label
              value='NEXT BUILD IN'
              fontSize={fpx(26)}
              color={{ r: 0.75, g: 0.85, b: 1, a: Math.max(0.4, 0.7 + Math.sin(floatTime * 3.5) * 0.3) }}
              uiTransform={{ width: '100%', height: pxm(58) }}
              textAlign='middle-center'
            />
          </UiEntity>

          {/* Countdown number — warm color cycle */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: barH + pxm(70), left: 0 }, width: '100%', height: pxm(200), alignItems: 'center', justifyContent: 'center' }}
          >
            <Label
              value={`${Math.max(0, cinematicSecondsLeft(phase, snap.secondsLeft))}`}
              fontSize={fpx(160)}
              color={{
                r: Math.min(1, 0.75 + Math.sin(floatTime * 2.0) * 0.25),
                g: Math.max(0, 0.75 + Math.sin(floatTime * 2.0 + 1.2) * 0.25),
                b: Math.max(0, 0.1  + Math.sin(floatTime * 2.0 + 2.4) * 0.15),
                a: 1
              }}
              uiTransform={{ width: '100%', height: pxm(200) }}
              textAlign='middle-center'
            />
          </UiEntity>

          {/* Depleting progress bar — total cinematic time remaining */}
          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { top: barH + pxm(288), left: cx(px(1200)) }, width: px(1200), height: px(5) }}
            uiBackground={{ color: { r: 0.08, g: 0.08, b: 0.25, a: 0.7 } }}
          >
            <UiEntity
              uiTransform={{
                width: Math.round(
                  (Math.max(0, cinematicSecondsLeft(phase, snap.secondsLeft)) /
                  (COUNTDOWN_SECONDS + PERFORMANCE_DURATION_SECONDS + RESET_DELAY_SECONDS)) * px(1200)
                ),
                height: px(5)
              }}
              uiBackground={{ color: { r: 0.3, g: 0.65, b: 1, a: 0.85 } }}
            />
          </UiEntity>

        </UiEntity>

        {/* System-failure cyan flash — outside cinematic container so it always renders */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0 },
            width: '100%', height: '100%',
            display: blueFlashAlpha > 0 ? 'flex' : 'none'
          }}
          uiBackground={{ color: { r: 0, g: 1, b: 1, a: blueFlashAlpha } }}
        />

      </UiEntity>
    )
  })
}
