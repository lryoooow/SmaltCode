import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { inspectorGeometry, type InspectorLayout } from './inspector-layout'

export default function WorkspaceSplit({ layout, onChange, conversation, inspector }: { layout: InspectorLayout; onChange: (change: (value: InspectorLayout) => InspectorLayout) => void; conversation: ReactNode; inspector: (focus: boolean) => ReactNode }) {
  const root = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; width: number }>()
  const [available, setAvailable] = useState(1000)
  useLayoutEffect(() => {
    const el = root.current; if (!el) return
    const update = () => { if (el.clientWidth) setAvailable(el.clientWidth) }
    update(); const observer = new ResizeObserver(update); observer.observe(el); return () => observer.disconnect()
  }, [])
  const geometry = inspectorGeometry(available, layout.width, layout.focus)
  const focus = layout.open && geometry.focus
  useEffect(() => {
    if (!focus) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"], .popover-surface')) return
      event.preventDefault(); onChange(value => ({ ...value, focus: false, open: value.focus }))
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="切换右侧面板 (Ctrl+J)"]')?.focus({ preventScroll: true }))
    }
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape)
  }, [focus, onChange])
  const resize = (width: number) => onChange(value => ({ ...value, width: Math.max(geometry.min, Math.min(geometry.max, width)) }))
  return <div ref={root} data-testid="workspace-split" data-mode={focus ? 'focus' : 'split'} className="flex flex-1 min-h-0 min-w-0">
    <div className="conversation-region min-w-0 flex-1 flex flex-col" hidden={focus}>{conversation}</div>
    {layout.open && <>
      {!focus && <div role="separator" aria-label="调整预览宽度" aria-orientation="vertical" aria-valuenow={Math.round(geometry.width)} aria-valuemin={geometry.min} aria-valuemax={geometry.max} tabIndex={0} className="panel-resizer" data-testid="panel-resizer"
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); drag.current = { x: e.clientX, width: geometry.width }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (drag.current) resize(drag.current.width + drag.current.x - e.clientX) }}
        onPointerUp={e => { drag.current = undefined; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
        onPointerCancel={() => { drag.current = undefined }}
        onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); resize(e.key === 'Home' ? geometry.min : e.key === 'End' ? geometry.max : geometry.width + (e.key === 'ArrowLeft' ? 24 : -24)) }} />}
      <div className="inspector-region flex flex-col min-w-0 min-h-0 shrink-0" style={{ width: focus ? '100%' : geometry.width }}>{inspector(focus)}</div>
    </>}
  </div>
}
