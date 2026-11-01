// system-prompt.test.ts — SYSTEM_PROMPT from .env replaces the default system prompt,
// and the prompt text never shows up in the server logs.
// Separate file + port: the main suite's server is spawned without the env var.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const PORT = 31598; // server.test.ts owns 31599; anything else free
const S = `http://127.0.0.1:${PORT}`;
const REPLY = "OK-REPLY-MARKER";
// \\n here mirrors what a .env value looks like; server.ts must turn it into real newlines.
const PROMPT = "You are terse.\\nAlways answer with one word.";

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } };
const seen: { body: any }[] = [];
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

const mock = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "mistral-large-4" }] });
    const body: any = await req.json();
    seen.push({ body });
    return new Response(
      [sse({ choices: [{ index: 0, delta: { content: REPLY } }] }), sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage }), "data: [DONE]\n\n"].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

let proc!: ReturnType<typeof Bun.spawn>;
let logs = "";

beforeAll(async () => {
  proc = Bun.spawn(["bun", "--no-env-file", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH!,
      MISTI_PORT: String(PORT),
      MISTRAL_API_KEY: "test-key-do-not-log",
      MISTRAL_BASE_URL: `http://127.0.0.1:${mock.port}`,
      SYSTEM_PROMPT: PROMPT,
      HTTPS_PROXY: "http://127.0.0.1:9", // offline, like the main suite
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) logs += new TextDecoder().decode(chunk);
  })();
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${S}/api/usage`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});

afterAll(() => {
  proc.kill();
  mock.stop(true);
});

test("SYSTEM_PROMPT replaces the default system prompt in the request", async () => {
  const res = await fetch(`${S}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: S },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(REPLY);
  const first: { role: string; content: string } = seen.at(-1)!.body.messages[0];
  expect(first.role).toBe("system");
  expect(first.content).toBe("You are terse.\nAlways answer with one word.");
  expect(first.content).not.toContain("auditor assistant");
});

test("system prompt text never lands in the server logs", async () => {
  await Bun.sleep(200); // let the stdout pipe drain past the request we just made
  expect(logs).not.toContain("terse");
});
