// ============================================================
// V13F — SONDA DE MÓDULOS
// Solo importa estáticamente lo que V12 demostró que funciona en
// móvil (ecs + math). Todos los módulos del juego se cargan UNO A
// UNO en runtime; el cartel flotante muestra cuál pasa y cuál
// revienta con su error. Un vistazo al móvil = culpable exacto.
// ============================================================
import {
  engine, Transform, GltfContainer, ColliderLayer, MeshRenderer,
  Material, TextShape, Billboard, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'

export async function main() {
  // Suelo primitivo + cartel: visibles pase lo que pase después.
  const ground = engine.addEntity()
  Transform.create(ground, { position: Vector3.create(16, 0.05, 16), scale: Vector3.create(30, 0.1, 30) })
  MeshRenderer.setBox(ground)
  Material.setPbrMaterial(ground, { albedoColor: Color4.create(0.15, 0.25, 0.2, 1) })

  setBeacon('sonda arrancando...')

  // Plataforma GLB (V12 la validó en móvil).
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
      lines.push(`${name}: ERROR ${String(err).slice(0, 80)}`)
    }
    setBeacon(lines.join('\n'))
    console.log(`[PROBE] ${lines[lines.length - 1]}`)
  }

  lines.push('--- SONDA COMPLETA ---')
  setBeacon(lines.join('\n'))
  console.log('[PROBE] end')
}

//  Cartel
let beaconEntity: ReturnType<typeof engine.addEntity> | null = null

function setBeacon(text: string): void {
  try {
    if (beaconEntity === null) {
      beaconEntity = engine.addEntity()
      Transform.create(beaconEntity, {
        position: Vector3.create(16, 4, 16),
        scale: Vector3.create(0.4, 0.4, 0.4)
      })
      TextShape.create(beaconEntity, {
        text: '',
        fontSize: 2,
        textColor: { r: 0.4, g: 1, b: 0.6, a: 1 },
        outlineColor: { r: 0, g: 0, b: 0 },
        outlineWidth: 0.1
      })
      Billboard.create(beaconEntity, { billboardMode: BillboardMode.BM_Y })
    }
    TextShape.getMutable(beaconEntity).text = text
  } catch (_) {}
}
