# Spec: vino-sdk (TypeScript client for vino-backend)

## Problem Statement

Developers who want to build clients against the vino-backend HTTP server must
hand-roll an HTTP caller: they re-implement SSE framing, event parsing, error
mapping, conversation pagination, and resume semantics every time. The only
reference is a raw `fetch` example in `docs/api.md`. There is no installable,
typed client that speaks the vino HTTP contract out of the box.

## Solution

Ship a small, zero-dependency TypeScript SDK (`vino-sdk`) that wraps the full
vino-backend HTTP surface behind one ergonomic `Vino` client. Consumers install
one module, construct `new Vino({ baseUrl })`, and call intent-shaped methods
(`run`, `stream`, `listConversations`, `getConversation`, `health`) — no SSE
parsing, no error mapping, no query encoding. The SDK exposes the event stream
as a typed async generator and a completion convenience that folds the stream
into a resolved `RunResult`.

## User Stories

1. As a developer, I want to install a single npm package, so that I can talk
   to a running vino-backend server without re-implementing an HTTP caller.
2. As a developer, I want a `Vino` client with a configurable `baseUrl`, so
   that I can point it at a server on a non-default address.
3. As a developer, I want to run the agent and receive the assistant's final
   answer as a promise, so that I don't have to assemble it from stream events.
4. As a developer, I want to stream a run as typed events, so that I can render
   text deltas as they arrive.
5. As a developer, I want `text_delta` events concatenated in order, so that
   I get the full assistant text from a convenience result.
6. As a developer, I want `tool_call_started`/`tool_result` pairs surfaced with
   typed `id`, `name`, `arguments`, `result`, and `error` fields, so that I can
   display or inspect tool activity.
7. As a developer, I want `run_started` metadata (conversation id, submission
   id, resumed flag) exposed, so that I can correlate runs and detect resumption.
8. As a developer, I want to pass a `requestId`, so that a retried request
   resumes the original run instead of duplicating it.
9. As a developer, I want to continue an existing conversation by passing a
   `conversationId`, so that I can build multi-turn sessions.
10. As a developer, I want to list conversations with pagination and ordering,
    so that I can build conversation browsers.
11. As a developer, I want to fetch one conversation's full transcript, so that
    I can display history.
12. As a developer, I want to check server liveness with a `health()` method,
    so that I can probe before starting work.
13. As a developer, I want HTTP failures raised as a typed `VinoHttpError`
    carrying the status and server message, so that I can branch on them.
14. As a developer, I want stream failures raised as a typed `VinoStreamError`,
    so that I can distinguish pre-stream validation errors from mid-run errors.
15. As a developer, I want to cancel an in-flight run with an `AbortSignal`, so
    that I can stop long-running work.
16. As a developer, I want an optional default request timeout on the client,
    so that hung servers don't hang my caller forever.
17. As a developer, I want to attach custom headers (and, in future, an API
    key), so that I can integrate with auth without an SDK upgrade.
18. As a developer, I want the SDK to work in Node 18+, browsers, Deno, and
    Bun, so that I can use it wherever I build.
19. As a developer, I want zero runtime dependencies, so that I don't inherit
    a supply chain for a thin HTTP client.
20. As a developer, I want a README quick-start and runnable examples, so that
    I'm productive in under a minute.
21. As a developer, I want the browser CORS limitation documented, so that I
    know to proxy or add CORS when using the SDK cross-origin.

## Implementation Decisions

- **Language/runtime**: TypeScript, ESM-only, Node 18+ floor (native `fetch`,
  `ReadableStream`, `AbortSignal`); works in browsers/Deno/Bun too.
- **Package**: `vino-sdk`, MIT, initial version `0.1.0`, public npm registry,
  zero runtime dependencies.
- **Public surface**: a `Vino` class with `health`, `run`, `stream`,
  `listConversations`, `getConversation`. Resume is expressed through
  `conversationId` in `RunOptions` (maps to `POST /conversations/{id}/runs`),
  not a separate method.
- **Streaming shape**: `stream()` returns `AsyncIterable<RunEvent>` (typed,
  discriminated union). `run()` returns `Promise<RunResult>` with the stream
  folded into `finalMessage`, `text`, `toolResults`, and run metadata. The
  `error` SSE event is yielded by `stream()` and thrown as `VinoStreamError`
  by `run()`.
- **Transport**: native `fetch` with a hand-rolled SSE frame parser (the server
  frames are `event: <name>\ndata: <json>\n\n`). No `EventSource` (POST-only
  endpoints), no external SSE dependency.
- **Errors**: `VinoError` base, `VinoHttpError` (non-2xx, carries `status` and
  server `error` string), `VinoStreamError` (terminal SSE `error` event or a
  stream that ends before `run_finished`).
- **Auth future-proofing**: `VinoOptions` accepts `headers` and `apiKey`
  (`apiKey` → `Authorization: Bearer <key>`); both applied to every request,
  inert until the server grows auth.
- **Config**: `VinoOptions` = `baseUrl` (default `http://127.0.0.1:8080`),
  `headers`, `apiKey`, `timeout` (default request timeout in ms, optional).
- **Types**: handwritten from `docs/api.md`, locked to the documented JSON
  shapes. `Message` follows the server's wire shape (`role`, `content`,
  `tool_calls`, `tool_call_id`, `name`, all optional except `role`); outgoing
  run messages are restricted to `role: "user" | "assistant"` with required
  non-empty `content`.
- **Pagination**: `listConversations` encodes `limit`/`cursor`/`order` into the
  query string; `nextCursor` is `string | null`.
- **Cancellation/timeout**: every method accepts `AbortSignal`; a client-level
  `timeout` is combined with any user signal so both can abort a request.

## Testing Decisions

Seams (where tests observe behavior; confirmed by the user):

- **Seam A — public API** (the `Vino` class): the highest seam. Integration
  tests boot the real vino-backend Go server and assert observable behavior
  through the client. Catches wire-format drift and end-to-end contract
  correctness. Misses nothing critical, but is slow and needs a Go toolchain.
- **Seam B — SSE framing** (the pure bytes→`RunEvent` parser): unit-tested
  without network by feeding chunked byte sequences (split frames, multi-chunk
  `data`, malformed JSON, unknown events). Catches the highest-risk parsing
  logic. Misses HTTP semantics, which Seam A covers.
- **Seam C — HTTP boundary** (the transport's request building and error
  mapping): unit-tested by injecting a fake `fetch` (system boundary, per the
  mocking rules). Catches query encoding, headers, and status→error mapping
  without a live server. Misses real wire compatibility, which Seam A covers.

A good test here asserts external behavior through the public interface and
uses independent, literal expected values (never recomputed), per the project's
TDD conventions. Integration tests boot the real server with `go run` and
auto-skip with a clear message when Go is absent.

## Out of Scope

- Server-side changes (auth, CORS, new endpoints). This SDK is client-only.
- Auto-retry / backoff. The SDK passes `requestId` through and exposes
  `resumed`; retry policy is the caller's.
- Per-request provider or model selection (the server fixes these at startup).
- A generated client or OpenAPI spec pipeline.
- A dedicated documentation site (README + examples + JSDoc only).
- Streaming tool-call argument deltas beyond what the server's final
  `tool_call_started` event already carries.

## Further Notes

- The server is loopback-only and sends no CORS headers; a cross-origin browser
  client needs same-origin serving or a server CORS change. Document this.
- Pinned integration fixture: vino-backend commit
  `afd9da512853e6d45a8fae3318a4a52da12ca87e`, vendored under
  `test/fixture/vino-backend` for reproducible tests.
- `npm publish` is intentionally left to the maintainer; the SDK is prepared
  for it (exports map, `files`, declaration output) but not published by the
  build.
