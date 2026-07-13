// How long to wait for the EngineApi.isServer RPC before assuming client.
const RPC_TIMEOUT_MS = 2000

// True when this runtime is definitely the headless authoritative server
// (scene-state-server runs on Deno). Synchronous — safe to call at any time.
export function isDenoServerRuntime(): boolean {
  return typeof globalThis !== 'undefined' && 'Deno' in globalThis
}

export async function isAuthoritativeServer(): Promise<boolean> {
  if (isDenoServerRuntime()) return true

  // Everything below is guarded: the '~system/EngineApi' import itself is
  // dynamic (a static import dies at module load on runtimes without it),
  // the isServer RPC may not exist, and when it exists it may never answer
  // (observed on mobile). Any failure or timeout means "client".
  try {
    const engineApi = await import('~system/EngineApi')
    if (typeof engineApi.isServer !== 'function') return false
    const response = await Promise.race([
      engineApi.isServer({}),
      new Promise<null>(resolve => setTimeout(() => resolve(null), RPC_TIMEOUT_MS))
    ])
    if (response === null) {
      console.log('[RUNTIME] EngineApi.isServer timed out — assuming client')
      return false
    }
    return response.isServer
  } catch (error) {
    console.log(`[RUNTIME] EngineApi.isServer failed — assuming client: ${error}`)
    return false
  }
}
