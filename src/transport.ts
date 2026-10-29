import { VinoHttpError, VinoStreamError } from "./errors.js";
import type {
  Conversation,
  ListConversationsResult,
  ListQuery,
  Message,
  RunEvent,
} from "./types.js";

/** The subset of `fetch` the transport relies on, injectable for tests. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Options for building a {@link Transport}. */
export interface TransportOptions {
  baseUrl: string;
  headers: Record<string, string>;
  fetch?: FetchLike;
  timeout?: number;
}

interface RunRequestBody {
  systemPrompt: string;
  messages: unknown[];
  maxIterations: number;
  toolTimeout: string;
  requestId: string;
}

/**
 * Internal HTTP layer. Owns base-URL joining, header/query handling, status
 * to error mapping, and the SSE stream. Consumers use {@link Vino}, not this.
 */
export class Transport {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeout?: number;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = { ...options.headers };
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeout = options.timeout;
  }

  health(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.requestJSON<{ ok: boolean }>("GET", "/health", undefined, signal);
  }

  streamRun(
    path: string,
    body: RunRequestBody,
    signal?: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    return streamEvents(this.fetchImpl, this.url(path), this.headers, this.timeout, body, signal);
  }

  listConversations(
    query: ListQuery,
    signal?: AbortSignal,
  ): Promise<ListConversationsResult> {
    return this.requestJSON<ListConversationsResult>(
      "GET",
      "/conversations",
      undefined,
      signal,
      this.queryParams(query),
    );
  }

  getConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
    return this.requestJSON<Conversation>(
      "GET",
      `/conversations/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
  }

  private url(path: string, query?: URLSearchParams): string {
    const qs = query?.toString();
    return qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
  }

  private queryParams(query: ListQuery): URLSearchParams {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    if (query.order !== undefined) params.set("order", query.order);
    return params;
  }

  private async requestJSON<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    query?: URLSearchParams,
  ): Promise<T> {
    const { signal: effective, cleanup } = withTimeout(signal, this.timeout);
    try {
      const headers: Record<string, string> = { ...this.headers };
      const init: RequestInit = { method, headers, signal: effective };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await this.fetchImpl(this.url(path, query), init);
      if (!res.ok) throw await toHttpError(res);
      return (await res.json()) as T;
    } finally {
      cleanup();
    }
  }
}

/**
 * Parses a byte stream of server-sent events into typed {@link RunEvent}s.
 * Frames are `event: <name>\ndata: <json>\n\n`. Unknown event names are
 * skipped (forward compatibility); malformed JSON raises {@link VinoStreamError}.
 */
export async function* parseSSE(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<RunEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = parseFrame(frame);
      if (event) yield event;
      sep = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const event = parseFrame(buffer);
    if (event) yield event;
  }
}

function parseFrame(frame: string): RunEvent | null {
  let name = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (dataLines.length === 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    throw new VinoStreamError(`malformed SSE data for event "${name}"`);
  }
  return toEvent(name, payload);
}

function toEvent(name: string, payload: unknown): RunEvent | null {
  switch (name) {
    case "run_started": {
      const p = payload as { conversationId?: string; submissionId?: string; resumed?: boolean };
      return {
        type: "run_started",
        conversationId: p.conversationId ?? "",
        submissionId: p.submissionId ?? "",
        resumed: p.resumed === true,
      };
    }
    case "text_delta": {
      const p = payload as { text?: string };
      return { type: "text_delta", text: p.text ?? "" };
    }
    case "tool_call_started": {
      const p = payload as {
        id?: string;
        name?: string;
        arguments?: Record<string, unknown> | null;
      };
      return {
        type: "tool_call_started",
        id: p.id ?? "",
        name: p.name ?? "",
        arguments: p.arguments ?? null,
      };
    }
    case "tool_result": {
      const p = payload as { id?: string; name?: string; result?: string; error?: string };
      const base = {
        type: "tool_result" as const,
        id: p.id ?? "",
        name: p.name ?? "",
        result: p.result ?? "",
      };
      return p.error === undefined ? base : { ...base, error: p.error };
    }
    case "run_finished": {
      const p = payload as { conversationId?: string; finalMessage?: Message };
      return {
        type: "run_finished",
        conversationId: p.conversationId ?? "",
        finalMessage: p.finalMessage ?? { role: "assistant" },
      };
    }
    case "error": {
      const p = payload as { error?: string };
      return { type: "error", error: p.error ?? "" };
    }
    default:
      return null;
  }
}

async function* streamEvents(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeout: number | undefined,
  body: RunRequestBody,
  signal: AbortSignal | undefined,
): AsyncGenerator<RunEvent> {
  const { signal: effective, cleanup } = withTimeout(signal, timeout);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: effective,
    });
    if (!res.ok) throw await toHttpError(res);
    if (!res.body) throw new VinoStreamError("response body is empty");
    yield* parseSSE(res.body);
  } finally {
    cleanup();
  }
}

async function toHttpError(res: Response): Promise<VinoHttpError> {
  let message = `HTTP ${res.status}`;
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data?.error === "string") message = data.error;
  } catch {
    // Non-JSON error body; keep the status-based message.
  }
  return new VinoHttpError(res.status, message);
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  if (timeoutMs === undefined) {
    return { signal, cleanup: () => {} };
  }
  if (signal === undefined) {
    const timer = AbortSignal.timeout(timeoutMs);
    return { signal: timer, cleanup: () => {} };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  const timer = setTimeout(
    () => controller.abort(new VinoStreamError(`request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

