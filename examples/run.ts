// In your own project: `import { Vino } from "vino-sdk";`
import { Vino } from "../src/index.js";

const vino = new Vino(); // defaults to http://127.0.0.1:8080

const result = await vino.run({
  systemPrompt: "You are a helpful coding assistant.",
  messages: [{ role: "user", content: "List the files in the current directory." }],
});

console.log(result.finalMessage.content);
console.log(`conversation: ${result.conversationId}`);
for (const tool of result.toolResults) {
  console.log(`tool ${tool.name} ->`, tool.result);
}
