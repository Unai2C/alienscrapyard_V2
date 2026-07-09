import { engine, Transform, GltfContainer, ColliderLayer } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { isMobile } from '@dcl/sdk/platform'
import { setIsMobile } from './client/platform'
import { isAuthoritativeServer, isDenoServerRuntime } from './shared/runtime'
import { initServer } from './server/server'
import { clientResolveSystem, setLocalPlayer, updateLocalDisplayName } from './client/client'
import { initArena, initScene, reconcileScene, cinematicAnimSystem, CINEMATIC_ANIM_ENABLED, trophySystem, boundaryGuardSystem } from './client/scene'
import { initHUD, initShoulder, hudInputSystem, hudTickSystem, getSelectedPart } from './client/hud'
import { cinematicSystem } from './client/cinematic'

export async function main() {
  // Fast-path visuals: unless this is definitely the headless server, show
  // the arena immediately. Nothing visual should ever wait on an RPC — an
  // explorer that is slow (or never) answering isServer would otherwise
  // keep the whole scene stuck at load (observed on mobile).
  if (!isDenoServerRuntime()) initArena()

  const isServer = await isAuthoritativeServer()
  console.log(`[RUNTIME] isServer=${isServer}`)

  if (isServer) {
    initServer()
  } else {
    await initClient()
  }
}

async function initClient(): Promise<void> {
  initArena()

  // Register resolution system before we know who the player is.
  engine.addSystem(clientResolveSystem, 0, 'dbc:resolve')

  await waitForPlayer()
}

function waitForPlayer(attempt = 0): Promise<void> {
  return new Promise(resolve => {
    function tryInit() {
      const player = getPlayer()
      const playerId = player?.userId?.trim()

      if (!playerId) {
        if (attempt < 30) {
          setTimeout(() => waitForPlayer(attempt + 1).then(resolve), 300)
        } else {
          console.log('[CLIENT] player not available after retries; skipping client init')
          resolve()
        }
        return
      }

      const displayName = player?.name?.trim() || playerId.slice(0, 8)
      setLocalPlayer(playerId, displayName)
      // Safe to query here: waitForPlayer already spans several frames, so
      // the async platform info is populated (frame-0 reads return null).
      setIsMobile(isMobile())
      console.log(`[CLIENT] platform mobile=${isMobile()}`)
      console.log(`[CLIENT] player=${displayName} (${playerId.slice(0, 8)})`)

      // Scene + HUD
      initScene(getSelectedPart)
      initHUD()
      initShoulder(engine.PlayerEntity)

      // Register systems in priority order.
      engine.addSystem(hudInputSystem,      2, 'dbc:hudInput')
      engine.addSystem(reconcileScene,      3, 'dbc:scene')
      engine.addSystem(hudTickSystem,       4, 'dbc:hudTick')
      engine.addSystem(cinematicSystem,     5, 'dbc:cinematic')
      if (CINEMATIC_ANIM_ENABLED) engine.addSystem(cinematicAnimSystem, 6, 'dbc:cinematicAnim')
      engine.addSystem(trophySystem,        7, 'dbc:trophy')
      engine.addSystem(boundaryGuardSystem, 8, 'dbc:boundaryGuard')

      // Poll until Decentraland profile delivers the real name (it can lag).
      refreshDisplayName(playerId, 0)

      resolve()
    }
    tryInit()
  })
}

function refreshDisplayName(playerId: string, attempt: number): void {
  if (attempt > 12) return
  setTimeout(() => {
    const player = getPlayer()
    const name = player?.name?.trim()
    if (name && name.length > 0) {
      updateLocalDisplayName(name)
      console.log(`[CLIENT] display name refreshed: ${name}`)
    } else {
      refreshDisplayName(playerId, attempt + 1)
    }
  }, 800)
}
