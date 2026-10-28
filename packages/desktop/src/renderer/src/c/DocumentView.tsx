import { useEffect, useRef, useState } from 'react'
import { Btn } from './ui'
import { errorText, type FilePreview } from '../bridge'
import workerSource from 'smalt-pdf-worker'
import { LocalBinaryDataFactory } from './pdf-assets'
import ObjectView from './ObjectView'
import type { ObjectSelection } from '../../../shared/browser'

export type DocumentPosition = { page?: number; sheet?: number; zoom?: number }
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

export default function DocumentView({ preview, name, position: externalPosition, onPosition: externalChange, onFeedback, onFocus }: { onFeedback?: (selection: ObjectSelection, note: string) => Promise<void>; onFocus?: () => void; preview: FilePreview; name: string; position?: DocumentPosition; onPosition?: (value: DocumentPosition) => void }) {
  const [localPosition, setLocalPosition] = useState<DocumentPosition>({})
  const position = externalPosition ?? localPosition, onPosition = externalChange ?? setLocalPosition
  return <div data-testid="document-preview">
    {!!preview.warnings?.length && <div className="px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)] border-b border-[var(--line)]">{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
    {preview.format === 'pdf' && preview.dataUrl ? <PdfView dataUrl={preview.dataUrl} position={position} onPosition={onPosition} />
      : ['image', 'xlsx'].includes(preview.format ?? '') ? <ObjectView key={name + ':' + preview.digest} preview={preview} name={name} position={position} onPosition={onPosition} onFeedback={onFeedback} onFocus={onFocus} />
      : preview.format === 'docx' ? <article data-testid="word-preview" className="p-5 space-y-3 leading-relaxed">{preview.paragraphs?.map((paragraph, index) => paragraph.heading ? <h3 key={index} className="font-semibold text-[16px] pt-2 whitespace-pre-wrap">{paragraph.text}</h3> : <p key={index} className="whitespace-pre-wrap break-words">{paragraph.text}</p>)}</article>
      : <pre className="p-4 text-[12px] whitespace-pre-wrap break-words">{preview.text || '空文件'}</pre>}
  </div>
}
