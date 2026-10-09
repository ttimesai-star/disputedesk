import { fileURLToPath } from "node:url";
import { createLlm } from "./agent/llm.ts";
import { createToolRunner } from "./agent/assistant.ts";
import { createApp } from "./app.ts";
import { createPayPalGateway } from "./paypal/index.ts";

const port = Number(process.env.PORT ?? 8787);
// Localhost by default: the dashboard can refund money and has no login. Set HOST=0.0.0.0 only inside a private network/container.
const host = process.env.HOST ?? "127.0.0.1";
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const dataDir = process.env.DATA_DIR || fileURLToPath(new URL("../../data", import.meta.url));

const paypal = createPayPalGateway();
const llm = createLlm();
const llmNames = [process.env.GEMINI_API_KEY ? `gemini:${process.env.GEMINI_MODEL || "gemini-2.5-flash"}` : null, process.env.GROQ_API_KEY ? `groq:${process.env.GROQ_MODEL || "llama-3.3-70b-versatile"}` : null].filter((x): x is string => !!x);
const tools = await createToolRunner(paypal).catch((e: unknown) => {
  console.warn(`PayPal Agent Toolkit unavailable: ${(e as Error).message}`);
  return null;
});
if (paypal.mode === "sandbox" && !process.env.PAYPAL_WEBHOOK_ID) console.warn("PAYPAL_WEBHOOK_ID is not set: incoming webhooks will be rejected.");

const { server } = createApp({
  paypal,
  llm,
  llmNames,
  tools,
  dataDir,
  staticDir,
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
  webhookVerify: process.env.PAYPAL_WEBHOOK_VERIFY === "offline" ? "offline" : "api",
});

server.listen(port, host, () => {
  console.log(`DisputeDesk on http://${host === "0.0.0.0" ? "localhost" : host}:${port}  paypal=${paypal.mode}  llm=${llmNames.join(",") || "off (rule-based drafts)"}  toolkit=${tools?.kind ?? "off"}`);
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
