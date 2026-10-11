// server.test.ts — black-box tests: real server.ts subprocess against a mock Mistral upstream.
// The mock picks its behaviour from a keyword in the last user message. No real API calls.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makePdf } from "./fixtures.ts";

const PORT = 31599;
const S = `http://127.0.0.1:${PORT}`;
const KEY = "test-key-do-not-log";
const SECRET = "SECRET-DOC-MARKER-7731"; // must never appear in server logs

// --- mock Mistral --------------------------------------------------------------------------

const seen: { auth: string | null; body: any }[] = [];
const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } };
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (text: string) => sse({ choices: [{ index: 0, delta: { content: text } }] });

const mock = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/v1/models") return Response.json({ data: [{ id: "mistral-large-4" }] });
    const body: any = await req.json();
    seen.push({ auth: req.headers.get("authorization"), body });
    const q: string = body.messages.at(-1).content;

    if (q.includes("ERR401")) return Response.json({ message: "Unauthorized" }, { status: 401 });
    if (q.includes("HTML")) return new Response("<html>blocked by proxy</html>", { status: 502, headers: { "content-type": "text/html" } });

    if (!body.stream) {
      if (q.includes("SLOW")) await Bun.sleep(3000);
      // Reasoning models return content as typed chunks; thinking must be dropped.
      const content = [{ type: "thinking", thinking: [{ type: "text", text: "hmm" }] }, { type: "text", text: "Buffered answer" }];
      return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage });
    }

    let frames: string[] = [delta("Hello"), delta(" world"), sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage }), "data: [DONE]\n\n"];
    if (q.includes("TRUNCATE")) frames = [delta("Hel")];
    if (q.includes("HANG")) frames = [];
    const hang = q.includes("HANG");
    return new Response(
      new ReadableStream({
        async start(c) {
          for (const f of frames) c.enqueue(new TextEncoder().encode(f));
          if (hang) return; // headers sent, then silence: idle watchdog must fire
          if (q.includes("LINGER")) return; // [DONE] sent but connection held open (proxy-like)
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

// --- server under test ---------------------------------------------------------------------

let proc: ReturnType<typeof Bun.spawn>;
let logs = "";

beforeAll(async () => {
  proc = Bun.spawn(["bun", "--no-env-file", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH!,
      MISTI_PORT: String(PORT),
      MISTRAL_API_KEY: KEY,
      MISTRAL_BASE_URL: `http://127.0.0.1:${mock.port}`,
      STREAM_IDLE_TIMEOUT_MS: "500",
      REQUEST_TIMEOUT_MS: "2000",
      MAX_DOC_CHARS: "1000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Collect logs for the whole run.
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

type Ev = { type: string; [k: string]: any };
async function chat(content: string, stream = true): Promise<Ev[]> {
  const res = await fetch(`${S}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: S },
    body: JSON.stringify({ stream, messages: [{ role: "user", content }] }),
  });
  expect(res.status).toBe(200);
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}
const textOf = (evs: Ev[]) => evs.filter((e) => e.type === "delta").map((e) => e.text).join("");

// --- tests ---------------------------------------------------------------------------------

describe("static + guard", () => {
  test("serves UI files, nothing else", async () => {
    expect(await (await fetch(`${S}/`)).text()).toContain("MISTI");
    expect((await fetch(`${S}/md.js`)).status).toBe(200);
    expect((await fetch(`${S}/server.ts`)).status).toBe(404);
  });

  test("rejects foreign Host (DNS rebinding)", async () => {
    expect((await fetch(`${S}/api/usage`, { headers: { host: `evil.com:${PORT}` } })).status).toBe(403);
  });

  test("rejects cross-site POST Origin, allows own origin", async () => {
    const post = (origin: string) =>
      fetch(`${S}/api/chat`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
    expect((await post("http://evil.com")).status).toBe(403);
    expect((await post(S)).status).toBe(400); // passes the guard, fails validation
  });
});

describe("api", () => {
  test("health", async () => {
    expect(await (await fetch(`${S}/api/health`)).json()).toMatchObject({ ok: true, modelAvailable: true });
  });

  test("extract: ok / too large / unsupported", async () => {
    const up = (data: ArrayBuffer, name: string) => {
      const fd = new FormData();
      fd.append("file", new File([data], name));
      return fetch(`${S}/api/extract`, { method: "POST", body: fd });
    };
    const ok = await up(makePdf([SECRET]), "secret-name.pdf");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: "pdf", text: SECRET });
    expect((await up(makePdf(Array(40).fill("x".repeat(40))), "big.pdf")).status).toBe(413);
    expect((await up(new ArrayBuffer(4), "a.txt")).status).toBe(422);
  });

  test("chat streaming: deltas, usage, cost; key + system prompt sent upstream", async () => {
    const evs = await chat(`hello ${SECRET}`);
    expect(textOf(evs)).toBe("Hello world");
    const done = evs.at(-1)!;
    expect(done).toMatchObject({ type: "done", finishReason: "stop", usage });
    expect(done.costUsd).toBeGreaterThan(0);
    const last = seen.at(-1)!;
    expect(last.auth).toBe(`Bearer ${KEY}`);
    expect(last.body.messages[0].role).toBe("system");
    expect(last.body.model).toBe("mistral-large-4");
  });

  test("chat buffered: thinking chunks dropped", async () => {
    const evs = await chat("hi", false);
    expect(textOf(evs)).toBe("Buffered answer");
    expect(evs.at(-1)!.type).toBe("done");
  });

  test("truncated stream (no [DONE]) -> reset + buffered retry", async () => {
    const evs = await chat("TRUNCATE");
    expect(evs.map((e) => e.type)).toEqual(["delta", "reset", "delta", "done"]);
    expect(evs[1].reason).toContain("[DONE]");
    expect(textOf(evs.slice(2))).toBe("Buffered answer");
    expect(seen.at(-1)!.body.stream).toBe(false);
  });

  test("silent stream -> idle watchdog -> buffered retry", async () => {
    const evs = await chat("HANG");
    expect(evs.map((e) => e.type)).toEqual(["reset", "delta", "done"]);
    expect(evs[0].reason).toContain("no bytes");
  });

  test("[DONE] ends the stream even if the connection lingers (no false fallback)", async () => {
    const evs = await chat("LINGER");
    expect(evs.map((e) => e.type)).toEqual(["delta", "delta", "done"]);
  });

  test("API error: not retried, message surfaced", async () => {
    const n = seen.length;
    const evs = await chat("ERR401");
    expect(evs).toEqual([{ type: "error", kind: "api", message: expect.stringContaining("401: Unauthorized") }]);
    expect(seen.length).toBe(n + 1);
  });

  test("HTML from upstream -> network/proxy error", async () => {
    const evs = await chat("HTML", false);
    expect(evs[0]).toMatchObject({ type: "error", kind: "network", message: expect.stringContaining("not from Mistral") });
  });

  test("hard deadline -> timeout", async () => {
    const evs = await chat("SLOW", false);
    expect(evs[0]).toMatchObject({ type: "error", kind: "timeout" });
  });

  test("too large conversation -> 413 before any upstream call", async () => {
    const n = seen.length;
    const res = await fetch(`${S}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x".repeat(1001) }] }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).kind).toBe("too_large");
    expect(seen.length).toBe(n);
  });

  test("usage accumulates over successful calls", async () => {
    const u = await (await fetch(`${S}/api/usage`)).json();
    expect(u.calls).toBe(5); // stream, buffered, truncate-retry, hang-retry, linger
    expect(u.promptTokens).toBe(500);
    expect(u.cachedTokens).toBe(200);
    const one = (60 * u.prices.input + 40 * u.prices.cache_read + 50 * u.prices.output) / 1e6;
    expect(u.usd).toBeCloseTo(5 * one, 10);
  });
});

describe("logging (runs last)", () => {
  test("rich forensics, but no key, doc text, prompts, filenames or bodies", async () => {
    await Bun.sleep(100); // let stdout drain
    for (const ev of ["[startup] misti", "mistral.headers", "mistral.stream_end", "chat.fallback", "mistral.http_error", "http.rejected"]) {
      expect(logs).toContain(ev);
    }
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain("secret-name");
    expect(logs).not.toContain("Hello world");
    expect(logs).not.toContain("blocked by proxy");
    expect(logs).not.toContain("Unauthorized");
  });
});
