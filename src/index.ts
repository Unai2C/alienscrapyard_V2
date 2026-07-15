// ============================================================
// RECONSTRUCCIÓN POR ETAPAS
//   V12  ✓: plataforma GLB + HUD (superada en móvil)
//   V13D (esta): JUEGO COMPLETO EN MODO LOCAL — rondas, bloques,
//        plantillas y HUD corriendo en el propio cliente. No se
//        toca '@dcl/sdk/network' ni '@dcl/sdk/players': la
//        simulación local demostró que la pila de sync del SDK
//        lanza errores sin capturar ("Couldn't fetch profile
//        data") que matan la escena en algunos runtimes.
//   Siguientes: +cinemática, +trofeos, +sync multijugador (cada
//        una como etapa aislada).
// ============================================================
import {
  engine, Transform, TextShape, Billboard, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { detectMobile } from './client/platform'
import { isDenoServerRuntime } from './shared/runtime'
import { initServer } from './server/server'
import { clientResolveSystem, setLocalPlayer, setLocalMode, updateLocalDisplayName } from './client/client'
import { initArena, initScene, reconcileScene, boundaryGuardSystem } from './client/scene'
import { initHUD, initShoulder, hudInputSystem, hudTickSystem, getSelectedPart } from './client/hud'

export async function main() {
  // Servidor autoritativo headless (Deno): solo el bucle de rondas con sync.
  if (isDenoServerRuntime()) {
    initServer()
    return
  }

  bootStatus('main')
  initArena()
  bootStatus('arena-ok')
  void detectMobile()

  // MODO LOCAL: el bucle de rondas corre en este mismo cliente y las
  // peticiones de colocación se procesan localmente. Cero networking.
  setLocalMode(true)
  try {
    initServer({ sync: false })
    bootStatus('local-rounds-ok')
  } catch (err) {
    bootStatus(`local-rounds-ERROR ${err}`)
  }

  engine.addSystem(clientResolveSystem, 0, 'dbc:resolve')

  // Identidad: vía '~system/UserIdentity' (dinámico + guarded). Sin ella,
  // identidad anónima local — el juego arranca igual.
  const { playerId, displayName } = await resolveIdentity()
  setLocalPlayer(playerId, displayName)
  updateLocalDisplayName(displayName)
  console.log(`[CLIENT] player=${displayName} (${playerId.slice(0, 8)})`)

  let failures = ''
  try {
    initScene(getSelectedPart, { trophies: false, particles: false })
    bootStatus('scene-ok')
  } catch (err) { failures += ` scene:${err}`; bootStatus(`scene-ERROR ${err}`) }

  try {
    initHUD()
    bootStatus('hud-ok')
  } catch (err) { failures += ` hud:${err}`; bootStatus(`hud-ERROR ${err}`) }

  try {
    initShoulder(engine.PlayerEntity)
  } catch (err) { failures += ` shoulder:${err}` }

  try {
    engine.addSystem(hudInputSystem,      2, 'dbc:hudInput')
    engine.addSystem(reconcileScene,      3, 'dbc:scene')
    engine.addSystem(hudTickSystem,       4, 'dbc:hudTick')
    engine.addSystem(boundaryGuardSystem, 8, 'dbc:boundaryGuard')
  } catch (err) { failures += ` systems:${err}` }

  bootStatus(failures === '' ? 'V13E ready' : `V13E con fallos:${failures}`)
}

//  Identidad sin '@dcl/sdk/players'
async function resolveIdentity(): Promise<{ playerId: string; displayName: string }> {
  const fallback = {
    playerId: `local-${Math.random().toString(36).slice(2, 10)}`,
    displayName: 'Player'
  }
  try {
    const userIdentity = await import('~system/UserIdentity')
    const res = await Promise.race([
      userIdentity.getUserData({}),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))
    ])
    const data = res && 'data' in res ? res.data : undefined
    if (data?.userId) {
      return { playerId: data.userId, displayName: data.displayName || data.userId.slice(0, 8) }
    }
    console.log('[CLIENT] getUserData sin userId — identidad local')
  } catch (err) {
    console.log(`[CLIENT] UserIdentity unavailable — identidad local: ${err}`)
  }
  return fallback
}

//  Baliza de arranque
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
