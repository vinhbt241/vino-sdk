import assert from "node:assert/strict";
import test from "node:test";

import { VinoStreamError } from "../../src/errors.js";
import { parseSSE } from "../../src/transport.js";
import type { RunEvent } from "../../src/types.js";

async function* bytesFrom(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

async function* byteByByte(input: string): AsyncGenerator<Uint8Array> {
  for (const byte of new TextEncoder().encode(input)) {
    yield new Uint8Array([byte]);
  }
}

async function collect(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

const TRANSCRIPT = [
  "event: run_started\n",
  'data: {"conversationId":"12","submissionId":"14","resumed":false}\n',
  "\n",
  "event: text_delta\n",
  'data: {"text":"I\'ll list the files."}\n',
  "\n",
  "event: tool_call_started\n",
  'data: {"id":"call_1","name":"ls","arguments":{"path":"."}}\n',
  "\n",
  "event: tool_result\n",
  'data: {"id":"call_1","name":"ls","result":"main.go\\ngo.mod\\n"}\n',
  "\n",
  "event: text_delta\n",
  'data: {"text":"Here\'s the listing."}\n',
  "\n",
  "event: run_finished\n",
  'data: {"finalMessage":{"role":"assistant","content":"Here\'s the listing."},"conversationId":"12"}\n',
  "\n",
].join("");

const EXPECTED_TRANSCRIPT: RunEvent[] = [
  {
    type: "run_started",
    conversationId: "12",
    submissionId: "14",
    resumed: false,
  },
  { type: "text_delta", text: "I'll list the files." },
  {
    type: "tool_call_started",
    id: "call_1",
    name: "ls",
    arguments: { path: "." },
  },
  {
    type: "tool_result",
    id: "call_1",
    name: "ls",
    result: "main.go\ngo.mod\n",
  },
  { type: "text_delta", text: "Here's the listing." },
  {
    type: "run_finished",
    conversationId: "12",
    finalMessage: { role: "assistant", content: "Here's the listing." },
  },
];

test("parses a full transcript delivered as one chunk", async () => {
  const events = await collect(parseSSE(bytesFrom(TRANSCRIPT)));
  assert.deepEqual(events, EXPECTED_TRANSCRIPT);
});

test("parses a transcript split byte by byte (including multi-byte text)", async () => {
  const input =
    'event: text_delta\ndata: {"text":"caf\u00e9 \u2713"}\n\n' +
    'event: run_finished\ndata: {"finalMessage":{"role":"assistant","content":"ok"},"conversationId":"1"}\n\n';
  const events = await collect(parseSSE(byteByByte(input)));
  assert.deepEqual(events, [
    { type: "text_delta", text: "caf\u00e9 \u2713" },
    {
      type: "run_finished",
      conversationId: "1",
      finalMessage: { role: "assistant", content: "ok" },
    },
  ]);
});

test("parses multiple events arriving in a single chunk", async () => {
  const input =
    'event: text_delta\ndata: {"text":"a"}\n\n' +
    'event: text_delta\ndata: {"text":"b"}\n\n';
  const events = await collect(parseSSE(bytesFrom(input)));
  assert.deepEqual(events, [
    { type: "text_delta", text: "a" },
    { type: "text_delta", text: "b" },
  ]);
});

test("joins multi-line data fields with a newline", async () => {
  const input = 'event: text_delta\ndata: {"text":\ndata: "hi"}\n\n';
  const events = await collect(parseSSE(bytesFrom(input)));
  assert.deepEqual(events, [{ type: "text_delta", text: "hi" }]);
});

test("maps the terminal error event", async () => {
  const input = 'event: error\ndata: {"error":"boom"}\n\n';
  const events = await collect(parseSSE(bytesFrom(input)));
  assert.deepEqual(events, [{ type: "error", error: "boom" }]);
});

test("yields null arguments when a tool call has none", async () => {
  const input =
    'event: tool_call_started\ndata: {"id":"c","name":"foo","arguments":null}\n\n';
  const events = await collect(parseSSE(bytesFrom(input)));
  assert.deepEqual(events, [
    { type: "tool_call_started", id: "c", name: "foo", arguments: null },
  ]);
});

test("skips unknown event names", async () => {
  const input = 'event: mystery\ndata: {"x":1}\n\n';
  const events = await collect(parseSSE(bytesFrom(input)));
  assert.deepEqual(events, []);
});

test("throws VinoStreamError on malformed JSON data", async () => {
  const input = 'event: text_delta\ndata: {not json}\n\n';
  await assert.rejects(
    async () => {
      for await (const _ of parseSSE(bytesFrom(input))) {
        /* consume */
      }
    },
    VinoStreamError,
  );
});

test("ignores a trailing partial frame with no data", async () => {
  const events = await collect(parseSSE(bytesFrom("event: text_delta\n")));
  assert.deepEqual(events, []);
});
