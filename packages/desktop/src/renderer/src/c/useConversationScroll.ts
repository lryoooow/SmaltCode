import { useLayoutEffect, useRef, useState, type UIEvent, type WheelEvent, type PointerEvent, type KeyboardEvent } from 'react'
import type { Session } from '../bridge'

export type ConversationScrollMemory = Map<string, { top: number; following: boolean; historyLimit?: number; detailLimits?: Record<string, number>; activities?: Set<string>; commands?: Set<string> }>

export function rememberExpansion(memory: ConversationScrollMemory, threadId: string, kind: 'activities' | 'commands', itemId: string, open: boolean) {
  const previous = memory.get(threadId) ?? { top: 0, following: true }
  const expanded = new Set(previous[kind])
  if (open) expanded.add(itemId); else expanded.delete(itemId)
  memory.set(threadId, { ...previous, [kind]: expanded })
}

/** User browsing takes priority over streaming updates, including small upward moves. */
export function useConversationScroll(session: Session, memory: ConversationScrollMemory) {
  const id = session.meta.id
  const saved = memory.get(id)
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(saved?.following ?? true)
  const previousTop = useRef(saved?.top ?? 0)
  const intent = useRef<'up' | 'down' | 'pointer' | 'inspect' | undefined>()
  const [stick, setStick] = useState(following.current)
  const [hasUpdates, setHasUpdates] = useState(false)
  const previous = useRef({ items: session.items, approvals: session.approvals, questions: session.questions })

  const remember = () => memory.set(id, { ...memory.get(id), top: viewport.current?.scrollTop ?? previousTop.current, following: following.current })
  const follow = (value: boolean) => {
    following.current = value
    setStick(value)
    if (value) setHasUpdates(false)
    remember()
  }
  const bottom = () => {
    const el = viewport.current
    if (el) { el.scrollTop = el.scrollHeight; previousTop.current = el.scrollTop; remember() }
  }
  const pause = (reason: typeof intent.current) => { intent.current = reason; follow(false) }
  const latest = () => { intent.current = undefined; follow(true); bottom() }

  useLayoutEffect(() => {
    const el = viewport.current!
    el.scrollTop = following.current ? el.scrollHeight : previousTop.current
    previousTop.current = el.scrollTop
    const observer = new ResizeObserver(() => { if (following.current) bottom() })
    observer.observe(el)
    if (content.current) observer.observe(content.current)
    return () => {
      observer.disconnect()
      memory.set(id, { ...memory.get(id), top: el.scrollTop, following: following.current })
    }
  }, [id, memory])

  useLayoutEffect(() => {
    const changed = previous.current.items !== session.items || previous.current.approvals !== session.approvals || previous.current.questions !== session.questions
    previous.current = { items: session.items, approvals: session.approvals, questions: session.questions }
    if (following.current) bottom()
    else if (changed) setHasUpdates(true)
  }, [session.items, session.approvals, session.questions])

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const movement = el.scrollTop - previousTop.current
    previousTop.current = el.scrollTop
    if (movement < -1) follow(false)
    else if (movement > 1 && el.scrollHeight - el.clientHeight - el.scrollTop <= 4 && (intent.current === 'down' || intent.current === 'pointer')) follow(true)
    remember()
  }
  const onWheelCapture = (event: WheelEvent<HTMLDivElement>) => {
    const nested = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-testid="activity-details"], [data-testid="command-output"]') : null
    if (nested && nested.scrollHeight > nested.clientHeight + 1) { pause('inspect'); return }
    if (event.deltaY < 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1) pause('up')
    else if (event.deltaY > 0) intent.current = 'down'
  }
  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) intent.current = 'pointer'
    else if (event.target instanceof Element && event.target.closest('[data-testid="activity-group"], [data-testid="plan-history"], [data-testid="item-agentMessage"], [data-testid="item-userMessage"]')) pause('inspect')
  }
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('textarea,input,select,[contenteditable="true"]')) return
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause('up')
    else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) intent.current = 'down'
    else if (['Enter', ' '].includes(event.key) && event.target instanceof Element && event.target.closest('[data-testid="activity-group"], [data-testid="plan-history"]')) pause('inspect')
  }
  return { viewport, content, stick, hasUpdates, latest, pauseBrowsing: () => pause('inspect'), onScroll, onWheelCapture, onPointerDownCapture, onKeyDownCapture }
}
