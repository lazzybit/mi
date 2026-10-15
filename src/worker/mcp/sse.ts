// Server-sent events parser for MCP streamable HTTP responses (ADR-0002: this is an MCP transport concern, not part of the model boundary).

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SseEvent, void, unknown> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException("aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEvent(raw);
        if (parsed) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
    }
    const trailing = parseEvent(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock?.();
  }
}

function parseEvent(raw: string): SseEvent | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0 && event === undefined) return undefined;
  return { event, data: dataLines.join("\n") };
}
