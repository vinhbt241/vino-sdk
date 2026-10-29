// In your own project: `import { Vino } from "vino-sdk";`
import { Vino } from "../src/index.js";

const vino = new Vino();

// List conversations, newest first.
const page = await vino.listConversations({ limit: 10 });
for (const conversation of page.conversations) {
  console.log(conversation.id, conversation.latestMessage?.content ?? "");
}

// Continue an existing conversation by id.
const result = await vino.run({
  conversationId: "12",
  messages: [{ role: "user", content: "What should I do next?" }],
});
console.log(result.finalMessage.content);
