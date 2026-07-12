// ============================================================
// V3 DIAGNOSTIC BUILD — escena mínima para aislar el fallo de
// carga en móvil. No importa NINGÚN módulo del juego: sin GLBs,
// sin UI, sin multijugador, sin sistemas complejos.
//   - Si esta versión NO carga en móvil → el problema es del
//     mundo/app, no de nuestra escena.
//   - Si carga → reintroducir piezas por versiones (V4: GLBs,
//     V5: UI, ...) hasta encontrar la que rompe.
// Revertir este commit para restaurar el juego completo.
// ============================================================
import {
  engine, Transform, MeshRenderer, MeshCollider, Material,
  TextShape, Billboard, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'

export function main() {
  console.log('[BOOT] v3-minimal main')

  // Suelo
  const ground = engine.addEntity()
  Transform.create(ground, {
    position: Vector3.create(16, 0.05, 16),
    scale: Vector3.create(30, 0.1, 30)
  })
  MeshRenderer.setBox(ground)
  MeshCollider.setBox(ground)
  Material.setPbrMaterial(ground, { albedoColor: Color4.create(0.2, 0.3, 0.25, 1) })

  // Cubo giratorio de referencia
  const cube = engine.addEntity()
  Transform.create(cube, { position: Vector3.create(16, 2, 16) })
  MeshRenderer.setBox(cube)
  Material.setPbrMaterial(cube, {
    albedoColor: Color4.create(0, 1, 1, 1),
    emissiveColor: { r: 0, g: 1, b: 1 },
    emissiveIntensity: 1
  })

  // Baliza de texto
  const label = engine.addEntity()
  Transform.create(label, { position: Vector3.create(16, 4, 16) })
  TextShape.create(label, {
    text: 'V3 MINIMAL OK',
    fontSize: 6,
    textColor: { r: 0.4, g: 1, b: 0.6, a: 1 },
    outlineColor: { r: 0, g: 0, b: 0 },
    outlineWidth: 0.1
  })
  Billboard.create(label, { billboardMode: BillboardMode.BM_Y })

  let t = 0
  engine.addSystem((dt: number) => {
    t += dt
    try {
      Transform.getMutable(cube).rotation = Quaternion.fromEulerDegrees(0, t * 60, 0)
    } catch (_) {}
  })

  console.log('[BOOT] v3-minimal ready')
}
