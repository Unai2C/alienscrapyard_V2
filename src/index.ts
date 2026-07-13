// ============================================================
// RECONSTRUCCIÓN POR ETAPAS — cada versión añade UNA pieza del
// juego; la primera etapa que no cargue en móvil identifica el
// módulo culpable sin ambigüedad.
//
//   V12 (esta): plataforma GLB + HUD + baliza
//   V13: + servidor de rondas + plantillas/bloques (scene.ts)
//   V14: + cinemática (letterbox + cámara virtual)
//   V15: + trofeos y partículas  → juego completo
// ============================================================
import {
  engine, Transform, GltfContainer, ColliderLayer,
  TextShape, Billboard, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { detectMobile } from './client/platform'
import { initHUD, hudInputSystem, hudTickSystem } from './client/hud'

export function main() {
  bootStatus('main')

  // Plataforma (GLB) creada inline — sin importar scene.ts en esta etapa.
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
    bootStatus('arena-ok')
  } catch (err) {
    bootStatus(`arena-ERROR ${err}`)
  }

  // Detección de plataforma (lazy + guarded, nunca lanza).
  void detectMobile()

  // HUD completo (react-ecs + audio).
  try {
    initHUD()
    engine.addSystem(hudInputSystem, 2, 'dbc:hudInput')
    engine.addSystem(hudTickSystem, 4, 'dbc:hudTick')
    bootStatus('hud-ok')
  } catch (err) {
    bootStatus(`hud-ERROR ${err}`)
    return
  }

  bootStatus('V12 ready')
}

//  Baliza de arranque
// Texto en escena visible en cualquier cliente sin consola. Si una etapa
// no aparece, el arranque murió justo antes de ella.
let bootEntity: ReturnType<typeof engine.addEntity> | null = null

function bootStatus(stage: string): void {
  console.log(`[BOOT] ${stage}`)
  try {
    if (bootEntity === null) {
      bootEntity = engine.addEntity()
      Transform.create(bootEntity, {
        position: Vector3.create(16, 9.5, 16),
        scale: Vector3.create(0.5, 0.5, 0.5)
      })
      TextShape.create(bootEntity, {
        text: '',
        fontSize: 3,
        textColor: { r: 0.4, g: 1, b: 0.6, a: 0.9 },
        outlineColor: { r: 0, g: 0, b: 0 },
        outlineWidth: 0.1
      })
      Billboard.create(bootEntity, { billboardMode: BillboardMode.BM_Y })
    }
    TextShape.getMutable(bootEntity).text = `boot: ${stage}`
  } catch (_) {}
}
