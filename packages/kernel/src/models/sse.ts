/** Minimal SSE parser over a fetch body stream, with idle-chunk stall watchdog. */

import { ModelError } from './types.js';

export interface SseOptions {
  /** Abort hung TCP streams when no chunk arrives within this window (ms). */
  stallTimeoutMs?: number;
}

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  opts?: SseOptions,
): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const stallTimeoutMs = opts?.stallTimeoutMs ?? 60_000;
  let buffer = '';
  let currentEvent: string | undefined;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const readPromise = reader.read();
      const result = stallTimeoutMs > 0
        ? await Promise.race([
            readPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                void reader.cancel().catch(() => {});
                reject(new ModelError(`Model stream stalled (no SSE data received within ${Math.round(stallTimeoutMs / 1000)}s)`));
              }, stallTimeoutMs);
              timer.unref?.();
            }),
          ]).finally(() => { if (timer) clearTimeout(timer); })
        : await readPromise;
      if (signal?.aborted) break;
      const { done, value } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line) {
          currentEvent = undefined;
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim() || undefined;
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          if (data !== '[DONE]') yield { event: currentEvent, data };
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  opts?: SseOptions,
): AsyncIterable<string> {
  for await (const ev of parseSseEvents(body, signal, opts)) {
    yield ev.data;
  }
}

/** Extract Retry-After / retry-after-ms hint from provider HTTP headers (bounded to 60s). */
export function parseRetryAfterMs(headers?: Headers): number | undefined {
  if (!headers) return undefined;
  const msHeader = headers.get('retry-after-ms');
  if (msHeader) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms > 0) return Math.min(60_000, Math.ceil(ms));
  }
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return undefined;
  const secs = Number(retryAfter);
  if (Number.isFinite(secs) && secs > 0) return Math.min(60_000, Math.ceil(secs * 1000));
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(60_000, delta);
  }
  return undefined;
}

/** Read a non-stream JSON error payload into a short message. */
export async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText || `HTTP ${res.status}`;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const err = (json.error ?? {}) as Record<string, unknown>;
    if (typeof err.message === 'string') return err.message;
    if (typeof json.message === 'string') return json.message;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 500);
}
