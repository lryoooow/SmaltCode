import { useEffect, useRef, useState } from 'react'
import { Btn } from './ui'
import { errorText, type FilePreview } from '../bridge'
import workerSource from 'smalt-pdf-worker'
import { LocalBinaryDataFactory } from './pdf-assets'

export type DocumentPosition = { page?: number; sheet?: number }
function PdfView({ dataUrl, position, onPosition }: { dataUrl: string; position: DocumentPosition; onPosition: (value: DocumentPosition) => void }) {
  const [document, setDocument] = useState<import('pdfjs-dist').PDFDocumentProxy>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(true)
  const [renderedPage, setRenderedPage] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null)
  const current = Math.max(1, Math.min(document?.numPages ?? 1, position.page ?? 1))
  useEffect(() => {
    let alive = true, loading: import('pdfjs-dist').PDFDocumentLoadingTask | undefined, worker: Worker | undefined, pdfWorker: import('pdfjs-dist').PDFWorker | undefined
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
    setDocument(undefined); setError(undefined); setBusy(true); setRenderedPage(0)
    void import('pdfjs-dist').then(async pdf => {
      if (!alive) return
      worker = new Worker(url); pdfWorker = pdf.PDFWorker.create({ port: worker })
      const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      loading = pdf.getDocument({ data: bytes, worker: pdfWorker, enableXfa: false, useSystemFonts: true, useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory, useWasm: false })
      const result = await loading.promise
      if (alive) setDocument(result)
    }).catch(e => { if (alive) { setError(errorText(e)); setBusy(false) } })
    return () => { alive = false; void loading?.destroy().catch(() => {}); pdfWorker?.destroy(); worker?.terminate(); URL.revokeObjectURL(url) }
  }, [dataUrl])
  useEffect(() => {
    if (!document) return
    let alive = true, render: import('pdfjs-dist').RenderTask | undefined
    setBusy(true); setError(undefined)
    const timer = setTimeout(() => { render?.cancel(); if (alive) { setError('此页绘制时间过长，请查看提取文字或尝试其他页面'); setBusy(false) } }, 15000)
    void document.getPage(current).then(async page => {
      if (!alive || !canvas.current) return
      const natural = page.getViewport({ scale: 1 }), width = Math.max(200, (container.current?.clientWidth ?? 340) - 24)
      const ratio = Math.min(devicePixelRatio || 1, 2)
      const scale = Math.min(width / natural.width * ratio, Math.sqrt(4_000_000 / (natural.width * natural.height)), 8192 / natural.width, 8192 / natural.height)
      const viewport = page.getViewport({ scale })
      canvas.current.width = Math.ceil(viewport.width); canvas.current.height = Math.ceil(viewport.height)
      canvas.current.style.width = viewport.width / ratio + 'px'; canvas.current.style.height = viewport.height / ratio + 'px'
      render = page.render({ canvas: canvas.current, viewport })
      render.onContinue = (resume: () => void) => requestAnimationFrame(() => { if (alive) resume() })
      await render.promise
      if (alive) { setRenderedPage(current); setBusy(false) }
    }).catch(e => { if (alive && e?.name !== 'RenderingCancelledException') { setError(errorText(e)); setBusy(false) } }).finally(() => clearTimeout(timer))
    return () => { alive = false; clearTimeout(timer); render?.cancel() }
  }, [document, current])
  return <div ref={container} data-testid="pdf-preview" aria-busy={busy || !error && renderedPage !== current} className="min-h-40">
    <div className="sticky top-0 z-10 flex items-center justify-center gap-3 px-2 py-2 bg-[var(--surface-solid)] border-b border-[var(--line)]"><Btn v="ghost" disabled={!document || current <= 1} onClick={() => onPosition({ ...position, page: current - 1 })}>上一页</Btn><span className="text-[12px] tabular-nums">{document ? current + ' / ' + document.numPages : '正在打开 PDF'}</span><Btn v="ghost" disabled={!document || current >= document.numPages} onClick={() => onPosition({ ...position, page: current + 1 })}>下一页</Btn></div>
    {busy && <div role="status" className="p-3 text-center text-[var(--muted)] text-[12px]">正在绘制页面…</div>}
    {error && <div role="alert" className="p-4 text-rose-500 break-words">{error}</div>}
    <div className="p-3 flex justify-center bg-[var(--sunken)]"><canvas ref={canvas} aria-label={'PDF 第 ' + current + ' 页'} className="bg-white shadow-sm max-w-full" /></div>
  </div>
}

export default function DocumentView({ preview, name, position: externalPosition, onPosition: externalChange }: { preview: FilePreview; name: string; position?: DocumentPosition; onPosition?: (value: DocumentPosition) => void }) {
  const [localPosition, setLocalPosition] = useState<DocumentPosition>({})
  const position = externalPosition ?? localPosition, onPosition = externalChange ?? setLocalPosition
  const [visibleRows, setVisibleRows] = useState(100), [imageError, setImageError] = useState(false)
  const sheets = preview.sheets ?? [], sheet = sheets[Math.min(position.sheet ?? 0, sheets.length - 1)]
  const columns = Math.max(1, ...(sheet?.rows ?? []).map(row => row.length))
  useEffect(() => { setVisibleRows(100); setImageError(false) }, [name, position.sheet, preview.digest])
  const letter = (index: number) => { let result = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result }
  return <div data-testid="document-preview">
    {!!preview.warnings?.length && <div className="px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)] border-b border-[var(--line)]">{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
    {preview.format === 'pdf' && preview.dataUrl ? <PdfView dataUrl={preview.dataUrl} position={position} onPosition={onPosition} />
      : preview.format === 'image' ? <div className="p-4 flex flex-col items-center gap-3">{imageError ? <div role="alert" className="text-rose-500">图片解码失败，请换一个有效的 PNG 或 JPEG 文件。</div> : <img src={preview.dataUrl} alt={name} onError={() => setImageError(true)} className="max-w-full max-h-[70vh] object-contain rounded-lg" />}<span className="text-[11px] text-[var(--muted)]">{(preview.size / 1024).toFixed(1)} KB</span></div>
      : preview.format === 'docx' ? <article data-testid="word-preview" className="p-5 space-y-3 leading-relaxed">{preview.paragraphs?.map((paragraph, index) => paragraph.heading ? <h3 key={index} className="font-semibold text-[16px] pt-2 whitespace-pre-wrap">{paragraph.text}</h3> : <p key={index} className="whitespace-pre-wrap break-words">{paragraph.text}</p>)}</article>
      : preview.format === 'xlsx' && sheet ? <div data-testid="spreadsheet-preview"><div role="tablist" aria-label="工作表" className="sticky top-0 z-10 flex overflow-auto gap-1 p-2 bg-[var(--surface-solid)] border-b border-[var(--line)]">{sheets.map((entry, index) => <button key={index} role="tab" aria-selected={entry === sheet} onClick={() => onPosition({ ...position, sheet: index })} className={'shrink-0 rounded-lg px-3 py-1.5 text-[12px] ' + (entry === sheet ? 'bg-[var(--accent-soft)] text-accent' : 'hover:bg-[var(--hover)] text-[var(--muted)]')}>{entry.name}</button>)}</div><div className="overflow-x-auto"><table className="border-collapse text-[11px] min-w-full"><thead><tr><th className="border-b border-r border-[var(--line)] p-2 bg-[var(--sunken)]" />{Array.from({ length: columns }, (_, index) => <th key={index} className="border-b border-r border-[var(--line)] px-3 py-2 min-w-24 bg-[var(--sunken)] font-medium">{letter(index)}</th>)}</tr></thead><tbody>{sheet.rows.slice(0, visibleRows).map((row, index) => <tr key={index}><th className="border-b border-r border-[var(--line)] px-2 py-1.5 text-[var(--muted)] bg-[var(--sunken)] font-normal tabular-nums">{index + 1}</th>{Array.from({ length: columns }, (_, column) => <td key={column} className="border-b border-r border-[var(--line)] px-3 py-1.5 max-w-64 truncate" title={row[column]}>{row[column] ?? ''}</td>)}</tr>)}</tbody></table></div>{visibleRows < sheet.rows.length && <div className="p-3 text-center"><Btn v="outline" onClick={() => setVisibleRows(value => value + 100)}>再显示 100 行</Btn></div>}<div className="p-3 text-[11px] text-[var(--muted)]">{sheet.rows.length} 行 · {sheet.name}</div></div>
      : <pre className="p-4 text-[12px] whitespace-pre-wrap break-words">{preview.text || '空文件'}</pre>}
  </div>
}
