/**
 * Wire-level types for the vino-agent HTTP API. These mirror the JSON
 * documented in the server's `docs/api.md` and are the single source of
 * truth for the client's request/response shapes.
 */

/** Author of a message as it appears in a server-side transcript. */
export type Role = "system" | "user" | "assistant" | "tool";

/** Role a caller is allowed to send in a run/resume request. */
export type OutgoingRole = "user" | "assistant";

/** A model tool call (part of an assistant message). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * A single conversation turn, in the server's wire shape. All fields except
 * `role` are optional because the server omits them when empty.
 */
export interface Message {
  role: Role;
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** A message the caller sends in a run/resume request. */
export interface OutgoingMessage {
  role: OutgoingRole;
  content: string;
}

/** One SSE event from a run stream, discriminated by `type`. */
export type RunEvent =
  | {
      type: "run_started";
      conversationId: string;
      submissionId: string;
      resumed: boolean;
    }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_started";
      id: string;
      name: string;
      arguments: Record<string, unknown> | null;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      result: string;
      error?: string;
    }
  | { type: "run_finished"; conversationId: string; finalMessage: Message }
  | { type: "error"; error: string };

/** Outcome of a single tool call within a run. */
export interface ToolResult {
  id: string;
  name: string;
  result: string;
  error?: string;
}

/** Options for `Vino.run` and `Vino.stream`. */
export interface RunOptions {
  /** Conversation turns, in order. Must be non-empty. */
  messages: OutgoingMessage[];
  /** System prompt prepended to the conversation. */
  systemPrompt?: string;
  /** Loop cap; 0/absent means the server default (50). */
  maxIterations?: number;
  /** Per-tool timeout as a Go duration string ("30s", "1m"). */
  toolTimeout?: string;
  /** Makes a run exactly-once: retries resume the original run. */
  requestId?: string;
  /** When set, the turns are appended to this conversation (resume). */
  conversationId?: string;
  /** Aborts the underlying request and stream. */
  signal?: AbortSignal;
}

/** The resolved outcome of a completed run. */
export interface RunResult {
  conversationId: string;
  submissionId: string;
  resumed: boolean;
  finalMessage: Message;
  /** All `text_delta` payloads concatenated in stream order. */
  text: string;
  toolResults: ToolResult[];
}

/** Options for constructing a {@link Vino} client. */
export interface VinoOptions {
  /** Server base URL. Defaults to `http://127.0.0.1:8080`. */
  baseUrl?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Optional API key, sent as `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Default request timeout in milliseconds. */
  timeout?: number;
  /**
   * Custom `fetch` implementation. Advanced: intended for testing and for
   * runtimes without a global `fetch`. Defaults to the global `fetch`.
   */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Pagination/ordering query for listing conversations. */
export interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

/** Reference to a parent conversation (present when forked). */
export interface ForkRef {
  conversationId: string;
  at: string;
}

/** Reference to the task that owns a conversation. */
export interface OwnerRef {
  conversationId: string;
  taskId: string;
}

/** Truncated preview of a conversation's latest message. */
export interface LatestMessage {
  role: string;
  content: string;
  truncated: boolean;
}

/** One conversation in a list response. */
export interface ConversationSummary {
  id: string;
  parent?: ForkRef;
  owner?: OwnerRef;
  latestMessage?: LatestMessage;
}

/** One entry in a conversation transcript. */
export interface Entry {
  id: string;
  kind: string;
  message: Message;
}

/** A full conversation with its transcript. */
export interface Conversation {
  id: string;
  parent?: ForkRef;
  owner?: OwnerRef;
  entries: Entry[];
}

/** Response from listing conversations. */
export interface ListConversationsResult {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}
