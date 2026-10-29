import assert from "node:assert/strict";
import test from "node:test";

import { VinoHttpError } from "../../src/errors.js";
import { Transport } from "../../src/transport.js";
import type { RunEvent } from "../../src/types.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
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

const RUN_BODY = {
  systemPrompt: "",
  messages: [{ role: "user" as const, content: "hi" }],
  maxIterations: 0,
  toolTimeout: "",
  requestId: "",
};

test("health resolves the parsed JSON body", async () => {
  const { fetchFn, calls } = fakeFetch(() => jsonResponse({ ok: true }));
  const transport = new Transport({ baseUrl: "http://127.0.0.1:8080", headers: {}, fetch: fetchFn });

  const result = await transport.health();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0]?.url, "http://127.0.0.1:8080/health");
  assert.equal(calls[0]?.init?.method, "GET");
});

test("health maps a non-2xx response to VinoHttpError", async () => {
  const { fetchFn } = fakeFetch(() => jsonResponse({ error: "down" }, 500));
  const transport = new Transport({ baseUrl: "http://x", headers: {}, fetch: fetchFn });

  await assert.rejects(transport.health(), (err: unknown) => {
    assert.ok(err instanceof VinoHttpError);
    assert.equal(err.status, 500);
    assert.equal(err.message, "down");
    return true;
  });
});

test("listConversations encodes query params and parses the page", async () => {
  const { fetchFn, calls } = fakeFetch((url) => {
    assert.match(url, /^http:\/\/x\/conversations\?/);
    assert.match(url, /limit=20/);
    assert.match(url, /cursor=12/);
    assert.match(url, /order=asc/);
    return jsonResponse({
      conversations: [{ id: "12", latestMessage: { role: "assistant", content: "hi", truncated: false } }],
      nextCursor: null,
    });
  });
  const transport = new Transport({ baseUrl: "http://x", headers: {}, fetch: fetchFn });

  const result = await transport.listConversations({ limit: 20, cursor: "12", order: "asc" });

  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0]?.id, "12");
  assert.equal(result.nextCursor, null);
  assert.equal(calls[0]?.init?.method, "GET");
});

test("getConversation URL-encodes the id", async () => {
  const { fetchFn, calls } = fakeFetch(() =>
    jsonResponse({ id: "12", entries: [] }),
  );
  const transport = new Transport({ baseUrl: "http://x", headers: {}, fetch: fetchFn });

  await transport.getConversation("1/2");

  assert.equal(calls[0]?.url, "http://x/conversations/1%2F2");
});

test("streamRun POSTs the run body and yields typed events", async () => {
  const { fetchFn, calls } = fakeFetch(() =>
    new Response(
      [
        'event: run_started',
        'data: {"conversationId":"1","submissionId":"2","resumed":false}',
        "",
        'event: text_delta',
        'data: {"text":"hi"}',
        "",
        'event: run_finished',
        'data: {"finalMessage":{"role":"assistant","content":"hi"},"conversationId":"1"}',
        "",
        "",
      ].join("\n"),
    ),
  );
  const transport = new Transport({ baseUrl: "http://x", headers: {}, fetch: fetchFn });

  const events = await collect(transport.streamRun("/runs", RUN_BODY));

  assert.deepEqual(events, [
    { type: "run_started", conversationId: "1", submissionId: "2", resumed: false },
    { type: "text_delta", text: "hi" },
    {
      type: "run_finished",
      conversationId: "1",
      finalMessage: { role: "assistant", content: "hi" },
    },
  ]);

  const init = calls[0]?.init;
  assert.equal(init?.method, "POST");
  assert.equal((init?.headers as Record<string, string>)?.["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init?.body as string), RUN_BODY);
});

test("streamRun maps a non-2xx response to VinoHttpError", async () => {
  const { fetchFn } = fakeFetch(() => jsonResponse({ error: "bad input" }, 400));
  const transport = new Transport({ baseUrl: "http://x", headers: {}, fetch: fetchFn });

  await assert.rejects(
    async () => {
      for await (const _ of transport.streamRun("/runs", RUN_BODY)) {
        /* consume */
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof VinoHttpError);
      assert.equal(err.status, 400);
      assert.equal(err.message, "bad input");
      return true;
    },
  );
});
