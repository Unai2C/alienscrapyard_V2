// ============================================================
// V13G — SONDA DE MÓDULOS con salida por UI de pantalla.
// Hallazgo V13F: TextShape (texto 3D) NO se renderiza en el
// explorador Godot móvil — todas las balizas anteriores eran
// invisibles allí. La sonda ahora pinta los resultados con
// react-ecs UI (probado en móvil: el letrero de V12 se veía).
// ============================================================
import {
  engine, Transform, GltfContainer, ColliderLayer, MeshRenderer,
  Material
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { initProbeUi, setProbeText } from './client/probe-ui'

export async function main() {
  // Panel de diagnóstico en pantalla — canal validado en móvil (V12).
  initProbeUi()

  // Plataforma GLB (validada en móvil).
  try {
    const arena = engine.addEntity()
    Transform.create(arena, {
      position: Vector3.create(16, 0, 16),
      rotation: Quaternion.Identity(),
      scale: Vector3.One()
    })
    GltfContainer.create(arena, {
      src: 'assets/scene/Models/DBC/DBCPLATAFORMA_20260429.glb',
      visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS,
      invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS
    })
  } catch (_) {}

  // Carga secuencial de cada módulo del juego.
  const probes: Array<[string, () => Promise<unknown>]> = [
    ['constants',  () => import('./shared/constants')],
    ['templates',  () => import('./shared/templates')],
    ['components', () => import('./shared/components')],
    ['runtime',    () => import('./shared/runtime')],
    ['platform',   () => import('./client/platform')],
    ['client',     () => import('./client/client')],
    ['hud',        () => import('./client/hud')],
    ['scene',      () => import('./client/scene')],
    ['server',     () => import('./server/server')],
    ['cinematic',  () => import('./client/cinematic')]
  ]

  const lines: string[] = []
  for (const [name, load] of probes) {
    try {
      await load()
      lines.push(`${name}: OK`)
    } catch (err) {
      lines.push(`${name}: ERROR ${String(err).slice(0, 90)}`)
    }
    setProbeText(lines.join('\n'))
    console.log(`[PROBE] ${lines[lines.length - 1]}`)
  }

  lines.push('--- SONDA COMPLETA (V13G) ---')
  setProbeText(lines.join('\n'))
  console.log('[PROBE] end')

  // Cubo giratorio como señal de vida del bucle de sistemas.
  const cube = engine.addEntity()
  Transform.create(cube, { position: Vector3.create(16, 10, 16) })
  MeshRenderer.setBox(cube)
  Material.setPbrMaterial(cube, {
    albedoColor: Color4.create(0, 1, 1, 1),
    emissiveColor: { r: 0, g: 1, b: 1 },
    emissiveIntensity: 1
  })
  let t = 0
  engine.addSystem((dt: number) => {
    t += dt
    try {
      Transform.getMutable(cube).rotation = Quaternion.fromEulerDegrees(0, t * 60, 0)
    } catch (_) {}
  })
}
