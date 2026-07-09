// Platform snapshot. We deliberately do NOT import '@dcl/sdk/platform': that
// module fires a getExplorerInformation RPC at module-load time, and our
// bundle is shared by the headless Deno server — an unimplemented system
// module there would crash the whole scene at eval. Detection here is lazy,
// guarded and time-boxed instead.
let mobile = false

export function getIsMobile(): boolean {
  return mobile
}

// Resolves once, caching the result in the module flag. Any failure —
// missing module, rejected RPC, no answer within 2s — leaves the desktop
// default in place. Never throws.
export async function detectMobile(): Promise<boolean> {
  try {
    const runtime = await import('~system/Runtime')
    const res = await Promise.race([
      runtime.getExplorerInformation({}),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 2000))
    ])
    if (res && typeof res.platform === 'string') {
      mobile = res.platform.toLowerCase() === 'mobile'
      console.log(`[PLATFORM] detected platform=${res.platform}`)
    } else {
      console.log('[PLATFORM] getExplorerInformation timed out — assuming desktop')
    }
  } catch (error) {
    console.log(`[PLATFORM] detection unavailable — assuming desktop: ${error}`)
  }
  return mobile
}
