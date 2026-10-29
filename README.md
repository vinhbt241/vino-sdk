# vino-sdk

Zero-dependency TypeScript client for the
[vino-backend](https://github.com/vinhbt241/vino-backend) HTTP API. Stream runs,
continue conversations, and read transcripts through one ergonomic client —
no hand-rolled SSE parsing or error mapping.

- **Runs on**: Node 18+, browsers, Deno, Bun (anything with `fetch`).
- **Dependencies**: none at runtime.
- **Types**: strict, handwritten from the server's documented wire contract.

## Install

```bash
npm install vino-sdk
```

## Quick start

The server defaults to `http://127.0.0.1:8080`.

```ts
import { Vino } from "vino-sdk";

const vino = new Vino();

// One-shot: get the final answer and tool activity.
const result = await vino.run({
  messages: [{ role: "user", content: "List the files in the current directory." }],
});

console.log(result.finalMessage.content);
console.log(result.text);                 // same text, streamed deltas concatenated
console.log(result.toolResults);          // [{ id, name, result }]
console.log(result.conversationId);
```

### Stream a run

`stream()` returns an async generator of typed, discriminated events:

```ts
for await (const event of vino.stream({
  messages: [{ role: "user", content: "List the files in ." }],
})) {
  switch (event.type) {
    case "run_started": break;
    case "text_delta": process.stdout.write(event.text); break;
    case "tool_call_started": console.log("calling", event.name, event.arguments); break;
    case "tool_result": console.log("result", event.result); break;
    case "run_finished": console.log("done", event.finalMessage); break;
    case "error": console.error(event.error); break;
  }
}
```

### Conversations

```ts
// List, newest first (paginated).
const page = await vino.listConversations({ limit: 20, order: "desc" });
console.log(page.nextCursor); // null on the last page

// Read a transcript.
const conversation = await vino.getConversation("12");

// Continue a conversation: pass conversationId on a new run/resume.
const next = await vino.run({
  conversationId: "12",
  messages: [{ role: "user", content: "What next?" }],
});
```

### Health

```ts
await vino.health(); // { ok: true }
```

## Configuration

```ts
const vino = new Vino({
  baseUrl: "http://127.0.0.1:8080", // default
  headers: { "x-custom": "value" }, // merged into every request
  apiKey: "sk-...",                 // sent as `Authorization: Bearer <key>`
  timeout: 30_000,                  // default request timeout, ms
});
```

`apiKey` is inert until the server grows auth; the SDK already sends it as a
bearer token so a future server change is a config update, not an SDK upgrade.

Every method accepts an optional `AbortSignal` as its last argument
(`run`/`stream` take it via `RunOptions.signal`):

```ts
const controller = new AbortController();
const result = await vino.run({ messages: [...], signal: controller.signal });
// controller.abort() cancels the in-flight request.
```

## Run options

```ts
interface RunOptions {
  messages: OutgoingMessage[];   // { role: "user" | "assistant"; content: string }
  systemPrompt?: string;
  maxIterations?: number;        // 0/absent -> server default (50)
  toolTimeout?: string;          // Go duration, e.g. "30s"
  requestId?: string;            // exactly-once: retries resume the same run
  conversationId?: string;       // present -> append to this conversation
  signal?: AbortSignal;
}
```

## Errors

```ts
import { VinoError, VinoHttpError, VinoStreamError } from "vino-sdk";

try {
  await vino.run({ messages: [{ role: "user", content: "hi" }] });
} catch (err) {
  if (err instanceof VinoHttpError) {
    console.error(err.status, err.message); // non-2xx before streaming
  } else if (err instanceof VinoStreamError) {
    console.error(err.message);             // terminal SSE error / premature end
  }
}
```

`stream()` yields the terminal `error` event rather than throwing it;
`run()` throws `VinoStreamError` instead.

## Browser / CORS note

The vino-backend server sends CORS headers, so a browser client can call the
API cross-origin directly — no reverse proxy required. If the server is
configured to allow only specific origins, make sure your app's origin is in
the allow-list.

## Development

```bash
npm install
npm run typecheck
npm test            # unit + integration (integration boots the real Go server)
npm run build       # emit dist/
```

Integration tests vendor the vino-backend server under
`test/fixture/vino-backend` and boot it with `go run` against a mock
OpenAI-compatible provider, so no API key is required. When Go is absent, the
integration suite auto-skips.

## License

MIT
