/** Minimal SSE parser over a fetch body stream. */

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          if (data !== '[DONE]') yield data;
        }
        // `event:` lines are ignored — adapters infer types from the payload
      }
    }
  } finally {
    reader.releaseLock();
  }
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
