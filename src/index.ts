// ============================================================
// RECONSTRUCCIÓN POR ETAPAS — cada versión añade UNA pieza.
//   V12 ✓: plataforma GLB + HUD + baliza (superada en móvil)
//   V13 (esta): + servidor de rondas + plantillas/bloques
//               (sin cinemática, sin trofeos, sin partículas)
//   V14: + cinemática (letterbox + cámara virtual)
//   V15: + trofeos y partículas → juego completo
// ============================================================
import {
  engine, Transform, TextShape, Billboard, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { detectMobile } from './client/platform'
import { isAuthoritativeServer, isDenoServerRuntime } from './shared/runtime'
import { initServer } from './server/server'
import { clientResolveSystem, setLocalPlayer, updateLocalDisplayName } from './client/client'
import { initArena, initScene, reconcileScene, boundaryGuardSystem } from './client/scene'
import { initHUD, initShoulder, hudInputSystem, hudTickSystem, getSelectedPart } from './client/hud'

export async function main() {
  if (!isDenoServerRuntime()) {
    bootStatus('main')
    initArena()
    bootStatus('arena-ok')
  }

  const isServer = await isAuthoritativeServer()
  console.log(`[RUNTIME] isServer=${isServer}`)

  if (isServer) {
    initServer()
  } else {
    await initClient()
  }
}

async function initClient(): Promise<void> {
  bootStatus('client-init')
  void detectMobile()
  await loadPlayersModule()
  engine.addSystem(clientResolveSystem, 0, 'dbc:resolve')
  await waitForPlayer()
}

// Lazy + guarded: importing '@dcl/sdk/players' statically evaluates its
// module (avatar/profile machinery) at bundle load — a crash there kills
// the scene before main(). Without it we fall back to an anonymous local
// player so the game still boots.
type GetPlayerFn = () => { userId?: string; name?: string } | null
let getPlayerFn: GetPlayerFn | null = null

async function loadPlayersModule(): Promise<void> {
  try {
    const m = await import('@dcl/sdk/players')
    getPlayerFn = m.getPlayer as GetPlayerFn
    bootStatus('players-ok')
  } catch (err) {
    bootStatus(`players-FALLBACK ${err}`)
  }
}

function readPlayer(): { userId?: string; name?: string } | null {
  if (getPlayerFn === null) return null
  try { return getPlayerFn() } catch (_) { return null }
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

function waitForPlayer(attempt = 0): Promise<void> {
  return new Promise(resolve => {
    function tryInit() {
      const player = readPlayer()
      let playerId = player?.userId?.trim()

      if (!playerId) {
        if (attempt === 0) bootStatus('player-wait')
        // Keep retrying while the profile loads, but never die: an explorer
        // that cannot deliver the profile still gets a playable game with
        // an anonymous local identity.
        if (attempt < 30 && getPlayerFn !== null) {
          setTimeout(() => waitForPlayer(attempt + 1).then(resolve), 300)
          return
        }
        playerId = `local-${Math.random().toString(36).slice(2, 10)}`
        console.log(`[CLIENT] player profile unavailable — using ${playerId}`)
      }

      const displayName = player?.name?.trim() || playerId.slice(0, 8)
      setLocalPlayer(playerId, displayName)
      console.log(`[CLIENT] player=${displayName} (${playerId.slice(0, 8)})`)

      // Cada paso aislado: un fallo se marca en la baliza y NO impide los
      // pasos siguientes — el HUD debe aparecer aunque la escena falle.
      let failures = ''
      try {
        // V13: plantillas y bloques activos; trofeos y partículas quedan
        // para la V15. La cinemática (V14) ni se importa en esta etapa.
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

      bootStatus(failures === '' ? 'V13C ready' : `V13C con fallos:${failures}`)

      refreshDisplayName(playerId, 0)
      resolve()
    }
    tryInit()
  })
}

function refreshDisplayName(playerId: string, attempt: number): void {
  if (attempt > 12) return
  setTimeout(() => {
    const player = readPlayer()
    const name = player?.name?.trim()
    if (name && name.length > 0) {
      updateLocalDisplayName(name)
      console.log(`[CLIENT] display name refreshed: ${name}`)
    } else {
      refreshDisplayName(playerId, attempt + 1)
    }
  }, 800)
}
