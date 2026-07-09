import { isServer } from '~system/EngineApi'

// How long to wait for the EngineApi.isServer RPC before assuming client.
const RPC_TIMEOUT_MS = 2000

// True when this runtime is definitely the headless authoritative server
// (scene-state-server runs on Deno). Synchronous — safe to call at any time.
export function isDenoServerRuntime(): boolean {
  return typeof globalThis !== 'undefined' && 'Deno' in globalThis
}

export async function isAuthoritativeServer(): Promise<boolean> {
  if (isDenoServerRuntime()) return true

  // Not every explorer implements the EngineApi.isServer RPC — mobile builds
  // have been observed to never answer it, which left main() awaiting forever
  // and the scene stuck at load. Racing a timeout guarantees startup can
  // never hang: an unanswered probe means we are a client.
  try {
    const response = await Promise.race([
      isServer({}),
      new Promise<null>(resolve => setTimeout(() => resolve(null), RPC_TIMEOUT_MS))
    ])
    if (response === null) {
      console.log('[RUNTIME] EngineApi.isServer timed out — assuming client')
      return false
    }
    return response.isServer
  } catch (error) {
    console.log('[RUNTIME] EngineApi.isServer failed — assuming client', error)
    return false
  }
}
