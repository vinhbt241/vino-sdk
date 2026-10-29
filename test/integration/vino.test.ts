import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Vino, type RunEvent } from "../../src/index.js";
import { freePort, startMockLLM, waitForHealth } from "./helpers.js";

const fixtureDir = fileURLToPath(new URL("../fixture/vino-agent", import.meta.url));
const goAvailable = spawnSync("go", ["version"]).status === 0;
const skipReason =
  goAvailable && existsSync(join(fixtureDir, "go.mod"))
    ? false
    : "go toolchain or pinned fixture unavailable";

let vino: Vino;
let tmp: string;
let serverProc: ChildProcess;
let mockLLM: { url: string; close: () => Promise<void> };
let firstConversationId = "";

before(async () => {
  if (skipReason) return;

  tmp = await mkdtemp(join(tmpdir(), "vino-sdk-"));
  const workDir = join(tmp, "work");
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "a.txt"), "aaa");
  await writeFile(join(workDir, "b.txt"), "bbb");

  mockLLM = await startMockLLM();
  const port = await freePort();
  const config = {
    addr: `127.0.0.1:${port}`,
    default: "openai",
    providers: {
      openai: { apiKey: "test-key", baseURL: mockLLM.url, model: "test-model" },
    },
    tools: { rootDir: workDir, workDir },
    durablePath: join(tmp, "vino.jsonl"),
  };
  const configPath = join(tmp, "vino.json");
  await writeFile(configPath, JSON.stringify(config));

  const serverBin = join(tmp, "server");
  const build = spawnSync("go", ["build", "-o", serverBin, "./cmd/server"], {
    cwd: fixtureDir,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr || "go build failed");

  serverProc = spawn(serverBin, ["--config", configPath], {
    cwd: fixtureDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  serverProc.stderr?.on("data", (chunk) => (stderr += chunk));

  vino = new Vino({ baseUrl: `http://127.0.0.1:${port}` });
  try {
    await waitForHealth(vino);
  } catch (err) {
    throw new Error(`${String(err)}\nserver stderr:\n${stderr}`);
  }
});

after(async () => {
  if (skipReason) return;
  if (serverProc && serverProc.exitCode === null) {
    const exited = new Promise<void>((resolve) => serverProc.once("exit", () => resolve()));
    serverProc.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  await mockLLM?.close();
  await rm(tmp, { recursive: true, force: true });
});

test("health returns ok", { skip: skipReason }, async () => {
  assert.deepEqual(await vino.health(), { ok: true });
});

test("run completes a tool-using run", { skip: skipReason }, async () => {
  const result = await vino.run({ messages: [{ role: "user", content: "list files" }] });
  firstConversationId = result.conversationId;

  assert.ok(result.conversationId.length > 0);
  assert.ok(result.submissionId.length > 0);
  assert.equal(result.resumed, false);
  assert.equal(result.finalMessage.role, "assistant");
  assert.equal(result.text, "Here are the files: a.txt, b.txt");
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0]?.name, "ls");
});

test("stream yields the full event sequence", { skip: skipReason }, async () => {
  const events: RunEvent[] = [];
  for await (const event of vino.stream({ messages: [{ role: "user", content: "list" }] })) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "run_started");
  assert.ok(events.some((e) => e.type === "text_delta"));
  assert.ok(events.some((e) => e.type === "tool_call_started" && e.name === "ls"));
  assert.ok(events.some((e) => e.type === "tool_result" && e.name === "ls"));
  assert.equal(events[events.length - 1]?.type, "run_finished");
});

test("listConversations returns the created conversation", { skip: skipReason }, async () => {
  const page = await vino.listConversations({ limit: 10 });
  assert.ok(page.conversations.some((c) => c.id === firstConversationId));
});

test("getConversation returns a transcript with a tool turn", { skip: skipReason }, async () => {
  const conversation = await vino.getConversation(firstConversationId);
  assert.equal(conversation.id, firstConversationId);
  assert.ok(conversation.entries.length >= 3);
  assert.ok(conversation.entries.some((e) => e.kind === "tool"));
  assert.ok(conversation.entries.some((e) => e.kind === "assistant"));
});

test("run resumes an existing conversation", { skip: skipReason }, async () => {
  const result = await vino.run({
    messages: [{ role: "user", content: "once more" }],
    conversationId: firstConversationId,
  });

  assert.equal(result.conversationId, firstConversationId);
  assert.equal(result.finalMessage.role, "assistant");
  assert.equal(result.text, "Here are the files: a.txt, b.txt");
});
