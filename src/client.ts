import { VinoStreamError } from "./errors.js";
import { Transport } from "./transport.js";
import type {
  Conversation,
  ListConversationsResult,
  ListQuery,
  Message,
  RunEvent,
  RunOptions,
  RunResult,
  ToolResult,
  VinoOptions,
} from "./types.js";

interface RunRequestBody {
  systemPrompt: string;
  messages: unknown[];
  maxIterations: number;
  toolTimeout: string;
  requestId: string;
}

/**
 * Client for the vino-agent HTTP API.
 *
 * ```ts
 * const vino = new Vino({ baseUrl: "http://127.0.0.1:8080" });
 *
 * // Stream a run as typed events:
 * for await (const ev of vino.stream({ messages: [{ role: "user", content: "hi" }] })) {
 *   if (ev.type === "text_delta") process.stdout.write(ev.text);
 * }
 *
 * // Or just the final result:
 * const result = await vino.run({ messages: [{ role: "user", content: "hi" }] });
 * console.log(result.finalMessage.content);
 * ```
 */
export class Vino {
  private readonly transport: Transport;

  constructor(options: VinoOptions = {}) {
    const baseUrl = options.baseUrl ?? "http://127.0.0.1:8080";
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.apiKey) headers["authorization"] = `Bearer ${options.apiKey}`;

    this.transport = new Transport({
      baseUrl,
      headers,
      timeout: options.timeout,
      fetch: options.fetch,
    });
  }

  /** Liveness probe. Resolves `{ ok: true }` when the server is up. */
  health(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.transport.health(signal);
  }

  /**
   * Runs the agent and resolves the completed result, folding the stream into
   * `finalMessage`, `text`, `toolResults`, and run metadata. Throws
   * {@link VinoStreamError} if the run aborts.
   */
  async run(options: RunOptions): Promise<RunResult> {
    let conversationId = "";
    let submissionId = "";
    let resumed = false;
    let text = "";
    const toolResults: ToolResult[] = [];
    let finalMessage: Message = { role: "assistant" };
    let finished = false;

    for await (const event of this.stream(options)) {
      switch (event.type) {
        case "run_started":
          conversationId = event.conversationId;
          submissionId = event.submissionId;
          resumed = event.resumed;
          break;
        case "text_delta":
          text += event.text;
          break;
        case "tool_result":
          toolResults.push(
            event.error === undefined
              ? { id: event.id, name: event.name, result: event.result }
              : { id: event.id, name: event.name, result: event.result, error: event.error },
          );
          break;
        case "run_finished":
          finished = true;
          finalMessage = event.finalMessage;
          break;
        case "error":
          throw new VinoStreamError(event.error);
      }
    }

    if (!finished) {
      throw new VinoStreamError("run stream ended before run_finished");
    }

    return { conversationId, submissionId, resumed, finalMessage, text, toolResults };
  }

  /**
   * Streams a run as typed {@link RunEvent}s. The terminal `error` event is
   * yielded (not thrown); use {@link run} to get a thrown {@link VinoStreamError}
   * instead. Pass `conversationId` to append to an existing conversation.
   */
  stream(options: RunOptions): AsyncGenerator<RunEvent> {
    const { conversationId, signal, ...rest } = options;
    const path = conversationId
      ? `/conversations/${encodeURIComponent(conversationId)}/runs`
      : "/runs";
    return this.transport.streamRun(path, toRunBody(rest), signal);
  }

  /** Lists conversations, newest first by default. */
  listConversations(
    query: ListQuery = {},
    signal?: AbortSignal,
  ): Promise<ListConversationsResult> {
    return this.transport.listConversations(query, signal);
  }

  /** Fetches one conversation with its full transcript. */
  getConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
    return this.transport.getConversation(id, signal);
  }
}

function toRunBody(options: {
  messages: RunOptions["messages"];
  systemPrompt?: string;
  maxIterations?: number;
  toolTimeout?: string;
  requestId?: string;
}): RunRequestBody {
  return {
    systemPrompt: options.systemPrompt ?? "",
    messages: options.messages,
    maxIterations: options.maxIterations ?? 0,
    toolTimeout: options.toolTimeout ?? "",
    requestId: options.requestId ?? "",
  };
}
