// In your own project: `import { Vino } from "vino-sdk";`
import { Vino } from "../src/index.js";

const vino = new Vino();

for await (const event of vino.stream({
  messages: [{ role: "user", content: "List the files in ." }],
})) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_call_started":
      console.log(`\n[tool] ${event.name}`, event.arguments);
      break;
    case "run_finished":
      console.log("\n[done]");
      break;
    case "error":
      console.error(`\n[error] ${event.error}`);
      break;
  }
}
