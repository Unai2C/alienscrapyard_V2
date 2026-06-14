//  Timing 
export const BUILD_DURATION_SECONDS = 60
export const BUILD_COMPLETE_SECONDS = 3
export const COUNTDOWN_SECONDS = 2
export const PERFORMANCE_DURATION_SECONDS = 3
export const RESET_DELAY_SECONDS = 2

// Cinematic safety net: if a client is still in non-BUILD phases after this
// many seconds past the expected cinematic window, release camera/UI and show
// the syncing state regardless of CRDT delivery.
export const CINEMATIC_WATCHDOG_GRACE_SECONDS = 2

// State freshness threshold. If no RoundState change is observed in this
// many milliseconds while we expect activity, the client treats itself stale.
export const STALE_THRESHOLD_MS = 4000

//  World 
export const SCENE_CENTER = { x: 16, y: 0, z: 16 }
export const TEMPLATE_BASE_Y = 6.8

// GLB models are exported at 2-unit native size. 0.52 makes each unit ~1.04m
// so blocks just touch at 1m spacing.
export const GLB_SCALE = 0.52

//  Parts 
export type PartType = 'CUBE' | 'CYLINDER' | 'CONE'
export const PART_TYPES: PartType[] = ['CUBE', 'CYLINDER', 'CONE']

export const PART_GLB: Record<PartType, string> = {
  CUBE:     'assets/scene/CUBE_OPAQUE.glb',
  CYLINDER: 'assets/scene/CYLINDER_OPAQUE.glb',
  CONE:     'assets/scene/PYRAMID_OPAQUE.glb'
}

export const PART_GLB_ALPHA: Record<PartType, string> = {
  CUBE:     'assets/scene/CUBE_ALPHA.glb',
  CYLINDER: 'assets/scene/CYLINDER_ALPHA.glb',
  CONE:     'assets/scene/PYRAMID_ALPHA.glb'
}

export const PART_LABEL: Record<PartType, string> = {
  CUBE:     'Cube',
  CYLINDER: 'Cylinder',
  CONE:     'Cone'
}

export const PART_SYMBOL: Record<PartType, string> = {
  CUBE:     '■',
  CYLINDER: '◊',
  CONE:     '▲'
}

//  Phase 
export type RoundPhase = 'IDLE' | 'BUILD' | 'BUILD_COMPLETE' | 'COUNTDOWN' | 'PERFORM' | 'RESET'

export type PerformanceType = 'PERFECT' | 'FAIL' | ''

export const PERFORMANCE_LABEL: Record<'PERFECT' | 'FAIL', string> = {
  PERFECT: 'PERFECT BUILD!',
  FAIL:    'INCOMPLETE'
}

export function getPerformanceType(attached: number, required: number): PerformanceType {
  return attached >= required ? 'PERFECT' : 'FAIL'
}

//  Logging 
export const DEBUG = false
