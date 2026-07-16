// ============================================================
// V14 — JUEGO COMPLETO EN MODO LOCAL sobre las reglas que el
// explorador Godot móvil impone (aprendidas con la sonda V13G):
//
//   1. engine.defineComponent SOLO funciona en la evaluación
//      inicial del bundle → los módulos con componentes custom
//      (components.ts, scene.ts y sus dependientes) se importan
//      ESTÁTICAMENTE. La sonda demostró que evaluados temprano
//      cargan OK (V12) y tardíos revientan ("Engine is already
//      sealed").
//   2. TextShape no se renderiza en móvil → el registro de
//      arranque usa UI react-ecs (probe-ui) y el HUD normal lo
//      reemplaza al final si todo fue bien.
//   3. '@dcl/sdk/network' y '@dcl/sdk/players' quedan fuera del
//      arranque (unhandled rejections) — modo local.
//
//   Etapas pendientes: +cinemática, +trofeos, +multijugador
//   (desktop primero).
// ============================================================
import { engine } from '@dcl/sdk/ecs'
import { initProbeUi, setProbeText } from './client/probe-ui'
import { detectMobile } from './client/platform'
import { isDenoServerRuntime } from './shared/runtime'
import { initServer } from './server/server'
import { clientResolveSystem, setLocalPlayer, setLocalMode, updateLocalDisplayName } from './client/client'
import { initArena, initScene, reconcileScene, boundaryGuardSystem } from './client/scene'
import { initHUD, initShoulder, hudInputSystem, hudTickSystem, getSelectedPart } from './client/hud'

const bootLog: string[] = []

function log(line: string): void {
  bootLog.push(line)
  setProbeText(bootLog.join('\n'))
  console.log(`[BOOT] ${line}`)
}

export async function main() {
  if (isDenoServerRuntime()) {
    initServer()
    return
  }

  initProbeUi()
  log('main')

  try {
    initArena()
    log('arena: OK')
  } catch (err) { log(`arena: ERROR ${err}`) }

  void detectMobile()

  // Rondas en modo local: el bucle del juego corre en este cliente.
  setLocalMode(true)
  try {
    initServer({ sync: false })
    log('rondas locales: OK')
  } catch (err) { log(`rondas locales: ERROR ${err}`) }

  engine.addSystem(clientResolveSystem, 0, 'dbc:resolve')

  const { playerId, displayName } = await resolveIdentity()
  setLocalPlayer(playerId, displayName)
  updateLocalDisplayName(displayName)
  log(`identidad: ${displayName}`)

  let failed = false
  try {
    initScene(getSelectedPart, { trophies: false, particles: false })
    log('escena: OK')
  } catch (err) { failed = true; log(`escena: ERROR ${err}`) }

  try {
    initShoulder(engine.PlayerEntity)
    log('pieza al hombro: OK')
  } catch (err) { log(`pieza al hombro: ERROR ${err}`) }

  try {
    engine.addSystem(hudInputSystem,      2, 'dbc:hudInput')
    engine.addSystem(reconcileScene,      3, 'dbc:scene')
    engine.addSystem(hudTickSystem,       4, 'dbc:hudTick')
    engine.addSystem(boundaryGuardSystem, 8, 'dbc:boundaryGuard')
    log('sistemas: OK')
  } catch (err) { failed = true; log(`sistemas: ERROR ${err}`) }

  if (!failed) {
    // Todo bien: el HUD del juego sustituye al panel de arranque.
    try {
      initHUD()
      console.log('[BOOT] V14 ready')
    } catch (err) {
      log(`hud: ERROR ${err}`)
    }
  } else {
    log('--- V14 con fallos: el panel queda visible ---')
  }
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
  } catch (err) {
    console.log(`[CLIENT] UserIdentity unavailable: ${err}`)
  }
  return fallback
}
