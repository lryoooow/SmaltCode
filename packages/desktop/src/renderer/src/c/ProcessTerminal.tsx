import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { errorText, store, type ManagedProcess, type ProcessOutput } from '../bridge'

type Cached = { terminal: Terminal; fit: FitAddon; element: HTMLDivElement; offset: number; onError: (message: string) => void }
const cache = new Map<string, Cached>()
/** Bounded native screen cache; closing a view never owns the process lifetime. */
export default function ProcessTerminal({ process, output, onError }: { process: ManagedProcess; output?: ProcessOutput; onError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null), current = useRef<Cached>()
  useEffect(() => {
    let saved = cache.get(process.id)
    if (!saved) {
      const terminal = new Terminal({ fontSize: 13, fontFamily: 'Cascadia Code, Consolas, Microsoft YaHei, monospace', scrollback: 2000, cursorBlink: false, theme: { background: '#101319', foreground: '#d7dce5', cursor: '#b1c2ff' }, allowProposedApi: false, disableStdin: true, convertEol: false })
      const fit = new FitAddon(); terminal.loadAddon(fit)
      const element = document.createElement('div'); element.className = 'h-full w-full'
      saved = { terminal, fit, element, offset: 0, onError }; terminal.open(element)
      const entry = saved
      // Program output cannot read/write the clipboard or activate arbitrary links.
      terminal.parser.registerOscHandler(52, () => true); terminal.parser.registerOscHandler(8, () => true)
      terminal.onData(data => { void store.api!.processes('write', { threadId: process.threadId, id: process.id, data }).catch(error => entry.onError(errorText(error))) })
      terminal.attachCustomKeyEventHandler(event => !(event.ctrlKey && ['f', 'k', 'j', 'b', ','].includes(event.key.toLowerCase())))
      cache.set(process.id, saved)
    }
    current.current = saved; saved.onError = onError
    cache.delete(process.id); cache.set(process.id, saved)
    while (cache.size > 8) { const [id, entry] = cache.entries().next().value!; if (id === process.id) break; entry.terminal.dispose(); cache.delete(id) }
    container.current!.appendChild(saved.element)
    const fit = () => {
      if (!container.current || container.current.clientWidth < 150 || container.current.clientHeight < 100) return
      try { saved.fit.fit(); const { cols, rows } = saved.terminal; if (cols >= 20 && rows >= 5) void store.api!.processes('resize', { threadId: process.threadId, id: process.id, columns: Math.min(400, cols), rows: Math.min(160, rows) }).catch(() => {}) } catch { /* hidden between a layout and fit */ }
    }
    const observer = new ResizeObserver(fit); observer.observe(container.current!); fit()
    void store.readProcess(process.threadId, process.id).catch(error => onError(errorText(error)))
    return () => { observer.disconnect(); saved.element.remove(); current.current = undefined }
  }, [process.id])
  useEffect(() => {
    const saved = current.current; if (!saved) return
    saved.terminal.options.disableStdin = process.kind !== 'terminal' || !process.inputAllowed || process.state !== 'running'
  }, [process.state, process.inputAllowed, process.kind])
  useEffect(() => {
    const saved = current.current; if (!saved || !output || output.end <= saved.offset) return
    if (saved.offset < output.from) { saved.terminal.reset(); saved.terminal.write('\x1b[90m[较早输出已截断，显示保留的末尾记录]\x1b[0m\r\n'); saved.offset = output.from }
    saved.terminal.write(output.data.slice(Math.max(0, saved.offset - output.from))); saved.offset = output.end
  }, [output])
  return <div ref={container} data-testid="process-terminal" role="region" aria-label={process.kind === 'terminal' ? '交互终端内容' : '后台进程输出'} className="flex-1 min-h-[100px] min-w-0 bg-[#101319] p-2" />
}
