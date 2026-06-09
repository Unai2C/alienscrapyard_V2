import { isServer } from '~system/EngineApi'

export async function isAuthoritativeServer(): Promise<boolean> {
  try {
    const response = await isServer({})
    return response.isServer
  } catch (error) {
    console.log('[RUNTIME] EngineApi.isServer failed, falling back to global detection', error)
    return typeof globalThis !== 'undefined' && 'Deno' in globalThis
  }
}
