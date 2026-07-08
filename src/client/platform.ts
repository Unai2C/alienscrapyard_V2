// Platform snapshot, set once at client init (after the first frame — the
// SDK populates platform info asynchronously and isMobile() lies during
// frame 0). Consumers read the cached flag instead of re-querying the SDK.
let mobile = false

export function setIsMobile(value: boolean): void {
  mobile = value
}

export function getIsMobile(): boolean {
  return mobile
}
