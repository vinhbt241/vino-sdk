import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import type { Vino } from "../../src/index.js";

/**
 * A minimal OpenAI-compatible mock. On the first call for a conversation
 * (no tool-result message yet) it asks for an `ls` tool call; once a tool
 * result is present it streams a final text answer.
 */
export function startMockLLM(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
        const sawToolResult = ((JSON.parse(body) as { messages?: { role?: string }[] }).messages ?? []).some(
          (m) => m.role === "tool",
        );

        res.writeHead(200, { "content-type": "text/event-stream" });
        if (sawToolResult) {
          res.write('data: {"choices":[{"delta":{"content":"Here are the files: "}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"a.txt, b.txt"}}]}\n\n');
        } else {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"ls","arguments":"{\\"path\\":\\".\\"}"}}]}}]}\n\n',
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitForHealth(vino: Vino, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const health = await vino.health();
      if (health.ok) return;
    } catch {
      // Server not up yet; keep polling.
    }
    if (Date.now() > deadline) throw new Error("vino-backend server did not become healthy");
    await new Promise((r) => setTimeout(r, 100));
  }
}
