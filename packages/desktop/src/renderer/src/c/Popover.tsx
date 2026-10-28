import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** One transient layer, anchored to its control; no modal focus trap. */
export default function Popover({ anchor, onClose, children, label, testId, width, above = false, menu = false, alignEnd = false }: { anchor: RefObject<HTMLElement>; onClose: () => void; children: ReactNode; label: string; testId?: string; width?: number; above?: boolean; menu?: boolean; alignEnd?: boolean }) {
  const id = useId(), panel = useRef<HTMLDivElement>(null), close = useRef(onClose)
  close.current = onClose
  const [position, setPosition] = useState<Record<string, number>>({ left: 12, top: 12, maxHeight: 320, width: 300 })
  useLayoutEffect(() => {
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return
      const topSpace = Math.max(0, rect.top - 20), bottomSpace = Math.max(0, innerHeight - rect.bottom - 20)
      const up = above ? topSpace >= 120 || topSpace > bottomSpace : bottomSpace < 240 && topSpace > bottomSpace
      const actualWidth = Math.max(0, Math.min(width ?? rect.width, innerWidth - 24))
      setPosition({ width: actualWidth, left: Math.max(12, Math.min(innerWidth - actualWidth - 12, alignEnd ? rect.right - actualWidth : rect.left)), ...(up ? { bottom: Math.max(12, innerHeight - rect.top + 8) } : { top: Math.max(12, rect.bottom + 8) }), maxHeight: Math.min(420, up ? topSpace : bottomSpace) })
    }
    update(); addEventListener('resize', update); document.addEventListener('scroll', update, true)
    return () => { removeEventListener('resize', update); document.removeEventListener('scroll', update, true) }
  }, [anchor, width, above, alignEnd])
  useEffect(() => {
    const other = (e: Event) => { if ((e as CustomEvent).detail !== id) close.current() }
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !panel.current?.contains(e.target) && !anchor.current?.contains(e.target)) close.current() }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      if (!menu && document.querySelector('[role="menu"]')) return
      if (e.target instanceof Node && panel.current?.contains(e.target)) { e.preventDefault(); anchor.current?.querySelector<HTMLElement>('button')?.focus(); if (anchor.current instanceof HTMLButtonElement) anchor.current.focus() }
      close.current()
    }
    addEventListener('smalt:popover-open', other); dispatchEvent(new CustomEvent('smalt:popover-open', { detail: id }))
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key)
    return () => { removeEventListener('smalt:popover-open', other); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key) }
  }, [id, anchor, menu])
  return createPortal(<div ref={panel} role={menu ? 'menu' : 'region'} aria-label={label} data-testid={testId} style={position} className="popover-surface fixed z-[90] flex flex-col overflow-y-auto overscroll-contain">{children}</div>, document.body)
}
