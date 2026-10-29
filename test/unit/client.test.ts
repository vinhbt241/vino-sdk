import assert from "node:assert/strict";
import test from "node:test";

import { Vino } from "../../src/client.js";
import { VinoStreamError } from "../../src/errors.js";
import type { RunEvent } from "../../src/types.js";

/** Builds one well-formed SSE frame. */
function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fakeFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init });
    return responder(input, init);
  };
  return { fetchFn, calls };
}

async function collect(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

test("run folds a full stream into a RunResult", async () => {
  const body =
    sse("run_started", { conversationId: "12", submissionId: "14", resumed: false }) +
    sse("text_delta", { text: "I'll " }) +
    sse("text_delta", { text: "look." }) +
    sse("tool_call_started", { id: "c1", name: "ls", arguments: { path: "." } }) +
    sse("tool_result", { id: "c1", name: "ls", result: "a.txt\nb.txt\n" }) +
    sse("run_finished", {
      finalMessage: { role: "assistant", content: "done" },
      conversationId: "12",
    });

  const { fetchFn } = fakeFetch(() => new Response(body));
  const vino = new Vino({ baseUrl: "http://x", fetch: fetchFn });

  const result = await vino.run({ messages: [{ role: "user", content: "ls" }] });

  assert.deepEqual(result, {
    conversationId: "12",
    submissionId: "14",
    resumed: false,
    finalMessage: { role: "assistant", content: "done" },
    text: "I'll look.",
    toolResults: [{ id: "c1", name: "ls", result: "a.txt\nb.txt\n" }],
  });
});

test("run throws VinoStreamError on a terminal error event", async () => {
  const body =
    sse("run_started", { conversationId: "1", submissionId: "2", resumed: false }) +
    sse("error", { error: "provider down" });

  const { fetchFn } = fakeFetch(() => new Response(body));
  const vino = new Vino({ baseUrl: "http://x", fetch: fetchFn });

  await assert.rejects(
    vino.run({ messages: [{ role: "user", content: "hi" }] }),
    (err: unknown) => {
      assert.ok(err instanceof VinoStreamError);
      assert.equal(err.message, "provider down");
      return true;
    },
  );
});

test("run throws VinoStreamError when the stream ends before run_finished", async () => {
  const body =
    sse("run_started", { conversationId: "1", submissionId: "2", resumed: false }) +
    sse("text_delta", { text: "partial" });

  const { fetchFn } = fakeFetch(() => new Response(body));
  const vino = new Vino({ baseUrl: "http://x", fetch: fetchFn });

  await assert.rejects(
    vino.run({ messages: [{ role: "user", content: "hi" }] }),
    VinoStreamError,
  );
});

test("stream with conversationId targets the resume endpoint", async () => {
  const body =
    sse("run_started", { conversationId: "12", submissionId: "20", resumed: true }) +
    sse("run_finished", {
      finalMessage: { role: "assistant", content: "ok" },
      conversationId: "12",
    });

  const { fetchFn, calls } = fakeFetch(() => new Response(body));
  const vino = new Vino({ baseUrl: "http://x", fetch: fetchFn });

  const events = await collect(
    vino.stream({ messages: [{ role: "user", content: "more" }], conversationId: "12" }),
  );

  assert.equal(calls[0]?.url, "http://x/conversations/12/runs");
  assert.equal(events[0]?.type, "run_started");
  if (events[0]?.type === "run_started") assert.equal(events[0].resumed, true);
});

test("apiKey and custom headers are applied to every request", async () => {
  const { fetchFn, calls } = fakeFetch(() => new Response('{"ok":true}'));
  const vino = new Vino({
    baseUrl: "http://x",
    headers: { "x-custom": "yes" },
    apiKey: "sk-123",
    fetch: fetchFn,
  });

  await vino.health();

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers?.["x-custom"], "yes");
  assert.equal(headers?.["authorization"], "Bearer sk-123");
});

test("default baseUrl is http://127.0.0.1:8080", async () => {
  const { fetchFn, calls } = fakeFetch(() => new Response('{"ok":true}'));
  const vino = new Vino({ fetch: fetchFn });

  await vino.health();

  assert.equal(calls[0]?.url, "http://127.0.0.1:8080/health");
});
