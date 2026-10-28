export type InspectorLayout = { open: boolean; width: number; focus: boolean; planPinned: boolean; planRequest: number }
export const emptyInspector = (width = 480): InspectorLayout => ({ open: false, width: Number.isFinite(width) ? Math.max(360, Math.min(960, width)) : 480, focus: false, planPinned: false, planRequest: 0 })
/** Width is the workspace after navigation, not the entire window. */
export function inspectorGeometry(available: number, requested: number, focused = false) {
  const focus = focused || available < 886
  const max = Math.max(360, Math.min(960, available - 526))
  return { focus, min: 360, max, width: focus ? available : Math.max(360, Math.min(max, Number.isFinite(requested) ? requested : 480)) }
}
