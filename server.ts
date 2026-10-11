// server.ts — MISTI: local, ZDR-compliant document-analysis UI.
// browser -> this server -> Mistral EU. Only stateless endpoints: /v1/chat/completions, /v1/models.
// The server keeps no conversation state; the browser resends doc text + history each turn.
// Logging is deliberately verbose (corporate proxy forensics) but never logs bodies or doc text.
import { join } from "node:path";
import { extractText } from "./extract.ts";

const PORT = Number(process.env.MISTI_PORT ?? 31571); // override only for tests
const BASE = process.env.MISTRAL_BASE_URL ?? "https://api.eu.mistral.ai";
const MODEL = process.env.MISTRAL_MODEL ?? "mistral-large-4";
const KEY = process.env.MISTRAL_API_KEY;
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS ?? 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 300_000);
const MAX_DOC_CHARS = Number(process.env.MAX_DOC_CHARS ?? 400_000);
const MAX_IMAGES = 16; // per conversation: every image is re-sent (and billed) on every turn
const HEALTH_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT =
  "You are a helpful, precise assistant. The user may attach documents; they appear inside " +
  "<document> tags. When answering about attached documents, base your answer on them and say so " +
  "when they do not contain the answer. Answer in the language of the user's question. " +
  "Format answers in Markdown.";

if (!KEY) {
  console.error("MISTRAL_API_KEY is not set (put it in .env next to server.ts and start from that directory).");
  process.exit(1);
}

// --- logging: one line per event, tagged with a request id ---------------------------------

let seq = 0;
const newId = () => `r${++seq}`;

function log(id: string, event: string, fields: Record<string, unknown> = {}) {
  const extra = Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  console.log(`${new Date().toISOString()} [${id}] ${event}${extra}`);
}

// Error anatomy is what tells TLS / DNS / refused / timeout apart behind a proxy.
function errInfo(err: any): Record<string, unknown> {
  const c = err?.cause;
  return {
    name: err?.name,
    code: err?.code,
    message: String(err?.message ?? err),
    ...(c ? { cause: { name: c.name, code: c.code, message: String(c.message ?? c) } } : {}),
  };
}

// Response headers that reveal who actually answered (Mistral vs. a proxy / block page).
function revealingHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (/^(via|server|content-type|content-length|x-cache|.*request-id|.*correlation-id|proxy-.*|x-squid.*|x-bluecoat.*|x-zscaler.*)$/i.test(k)) out[k] = v;
  });
  return out;
}

// --- errors --------------------------------------------------------------------------------

type Kind = "network" | "api" | "timeout" | "idle" | "truncated" | "bad_response" | "too_large" | "aborted";

// `message` is safe to log; `detail` (from a response body) goes to the UI only, never to logs.
class ChatError extends Error {
  constructor(public kind: Kind, message: string, public detail = "") {
    super(message);
  }
}

// Failures of the streaming attempt that a buffered retry might survive.
const RETRYABLE: Kind[] = ["network", "idle", "truncated", "bad_response"];

function networkError(err: any): ChatError {
  const code = String(err?.code ?? err?.cause?.code ?? err?.name ?? "");
  const tls = /CERT|SSL|TLS|SELF_SIGNED/i.test(code + " " + String(err?.message));
  const proxy = (process.env.HTTPS_PROXY ?? process.env.https_proxy)?.replace(/\/\/[^@/]*@/, "//***@");
  const hint = tls
    ? "TLS error — corporate TLS inspection? Try NODE_EXTRA_CA_CERTS=corp-ca.pem"
    : proxy
      ? `check VPN/proxy (going via HTTPS_PROXY=${proxy})`
      : "check VPN/proxy (no HTTPS_PROXY set — going direct)";
  return new ChatError("network", `network error (${code || "unknown"}): ${err?.message ?? err} — ${hint}`);
}

// --- Mistral transport ---------------------------------------------------------------------

// fetch + header/status logging + error classification. Returns only ok responses.
async function mistralFetch(id: string, path: string, init: RequestInit): Promise<Response> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    });
  } catch (err) {
    if (init.signal?.aborted) throw init.signal.reason; // our own timeout/abort, already a ChatError
    log(id, "mistral.fetch_error", { path, ms: Math.round(performance.now() - t0), ...errInfo(err) });
    throw networkError(err);
  }
  log(id, "mistral.headers", { path, status: res.status, ms: Math.round(performance.now() - t0), headers: revealingHeaders(res.headers) });
  if (res.ok) return res;

  // Error body: read for its length + (JSON only) a message for the UI. Never logged.
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text().catch(() => "");
  log(id, "mistral.http_error", { path, status: res.status, contentType: ct, bodyLen: body.length });
  if (!ct.includes("json")) {
    // HTML/plain error from a non-Mistral party = almost certainly a proxy or captive portal.
    throw new ChatError("network", `HTTP ${res.status} with ${ct || "no content-type"} (not from Mistral?) — check VPN/proxy`);
  }
  let detail = "";
  try {
    const j = JSON.parse(body);
    detail = typeof j.message === "string" ? j.message : JSON.stringify(j.message ?? j.detail ?? j);
  } catch {}
  throw new ChatError("api", `Mistral API error ${res.status}`, detail.slice(0, 300));
}

type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
type Outcome = { content: string; finishReason?: string; usage?: Usage };
// User turns may carry images: content becomes text + image_url parts (inline data: URLs only).
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: string };
type Msg = { role: "user" | "assistant"; content: string | Part[] };

// Only inline images: a remote URL would make Mistral fetch it from a third party.
const okPart = (p: any) =>
  (p?.type === "text" && typeof p.text === "string") ||
  (p?.type === "image_url" && typeof p.image_url === "string" && p.image_url.startsWith("data:image/"));
const okMsg = (m: any) =>
  (m?.role === "user" || m?.role === "assistant") &&
  (typeof m.content === "string" || (m.role === "user" && Array.isArray(m.content) && m.content.length > 0 && m.content.every(okPart)));

// Sizes for guards and logs; never the content itself.
function measure(messages: Msg[]) {
  let chars = 0, images = 0, imageBytes = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else
      for (const p of m.content) {
        if (p.type === "text") chars += p.text.length;
        else (images++, (imageBytes += p.image_url.length));
      }
  }
  return { chars, images, imageBytes };
}

// Message content is a string, or (reasoning models) an array of typed chunks; keep only text.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
  return "";
}

// One call to /v1/chat/completions, streaming or buffered.
async function chatAttempt(id: string, messages: Msg[], stream: boolean, outer: AbortSignal, onDelta: (s: string) => void): Promise<Outcome> {
  const idle = new AbortController();
  const signal = AbortSignal.any([outer, idle.signal]);
  let timer: Timer | undefined;
  // Idle watchdog: only a genuinely silent stream trips it (buffered calls rely on the deadline).
  const arm = () => {
    clearTimeout(timer);
    if (stream) timer = setTimeout(() => idle.abort(new ChatError("idle", `no bytes for ${STREAM_IDLE_TIMEOUT_MS} ms`)), STREAM_IDLE_TIMEOUT_MS);
  };

  log(id, "mistral.start", { model: MODEL, stream, messages: messages.length, ...measure(messages) });
  const t0 = performance.now();
  arm();
  try {
    const res = await mistralFetch(id, "/v1/chat/completions", {
      method: "POST",
      signal,
      body: JSON.stringify({ model: MODEL, stream, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages] }),
    });
    const ct = res.headers.get("content-type") ?? "";

    if (!stream) {
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        log(id, "mistral.bad_json", { contentType: ct, bodyLen: text.length });
        throw new ChatError("bad_response", `unparseable response (${ct}, ${text.length} bytes) — proxy mangling?`);
      }
      const choice = data.choices?.[0];
      const out = { content: textOf(choice?.message?.content), finishReason: choice?.finish_reason, usage: data.usage };
      log(id, "mistral.done", { stream, ms: Math.round(performance.now() - t0), bytes: text.length, finishReason: out.finishReason, usage: out.usage });
      onDelta(out.content);
      return out;
    }

    if (!ct.includes("text/event-stream")) log(id, "mistral.unexpected_content_type", { contentType: ct });

    // SSE: "data: {json}" lines, terminated by "data: [DONE]".
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "", content = "", finishReason: string | undefined, usage: Usage | undefined;
    let chunks = 0, bytes = 0, maxGap = 0, ttfb = -1, sawDone = false, badLines = 0;
    let last = performance.now();
    while (!sawDone) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        log(id, "mistral.stream_read_error", { chunks, bytes, ...errInfo(err) });
        throw networkError(err);
      }
      if (r.done) break;
      const now = performance.now();
      if (ttfb < 0) ttfb = Math.round(now - t0);
      maxGap = Math.max(maxGap, now - last);
      last = now;
      chunks++;
      bytes += r.value.byteLength;
      arm();
      buf += dec.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          // Stop at the sentinel: a proxy holding the connection open must not trip the idle watchdog.
          sawDone = true;
          reader.cancel().catch(() => {});
          break;
        }
        try {
          const j = JSON.parse(payload);
          const c = j.choices?.[0];
          const delta = textOf(c?.delta?.content);
          if (delta) {
            content += delta;
            onDelta(delta);
          }
          if (c?.finish_reason) finishReason = c.finish_reason;
          if (j.usage) usage = j.usage;
        } catch {
          badLines++;
        }
      }
    }
    log(id, "mistral.stream_end", {
      ms: Math.round(performance.now() - t0), ttfbMs: ttfb, chunks, bytes, maxGapMs: Math.round(maxGap),
      sawDone, badLines, finishReason, usage,
    });
    if (!sawDone) throw new ChatError("truncated", "stream ended without [DONE]");
    return { content, finishReason, usage };
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- cost ------------------------------------------------------------------------------------

// USD per 1M tokens; replaced from models.dev at startup when reachable.
const prices = { input: 0.68, output: 2.09, cache_read: 0.07 };
let priceSource = "fallback constants";
const totals = { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, usd: 0 };

async function loadPrices() {
  const id = "startup";
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5000) });
    const cost = (await res.json())?.mistral?.models?.[MODEL]?.cost;
    if (typeof cost?.input !== "number" || typeof cost?.output !== "number") throw new Error(`no price for ${MODEL}`);
    Object.assign(prices, { input: cost.input, output: cost.output, cache_read: cost.cache_read ?? cost.input });
    priceSource = "models.dev";
  } catch (err) {
    log(id, "prices.fallback", errInfo(err));
  }
  log(id, "prices", { source: priceSource, ...prices });
}

function addUsage(u: Usage): number {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const usd = ((u.prompt_tokens - cached) * prices.input + cached * prices.cache_read + u.completion_tokens * prices.output) / 1e6;
  totals.calls++;
  totals.promptTokens += u.prompt_tokens;
  totals.cachedTokens += cached;
  totals.completionTokens += u.completion_tokens;
  totals.usd += usd;
  return usd;
}

// --- HTTP handlers ---------------------------------------------------------------------------

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function handleChat(id: string, req: Request): Promise<Response> {
  const { messages, stream } = (await req.json()) as { messages: Msg[]; stream: boolean };
  if (!Array.isArray(messages) || !messages.length || !messages.every(okMsg)) {
    return json({ kind: "bad_request", message: "messages must be [{role, content: string | user parts [text, image_url (data:image/...)]}]" }, 400);
  }
  // Guards cover the whole conversation (docs + images + history), since all of it is billed each turn.
  const { chars, images } = measure(messages);
  if (chars > MAX_DOC_CHARS) {
    log(id, "chat.too_large", { chars, max: MAX_DOC_CHARS });
    return json({ kind: "too_large", message: `conversation is ${chars} chars, limit is ${MAX_DOC_CHARS} (MAX_DOC_CHARS)` }, 413);
  }
  if (images > MAX_IMAGES) {
    log(id, "chat.too_many_images", { images, max: MAX_IMAGES });
    return json({ kind: "too_large", message: `conversation has ${images} images, limit is ${MAX_IMAGES} — start a new chat` }, 413);
  }

  // One controller for the hard deadline and browser disconnects; reasons are ChatErrors.
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(new ChatError("timeout", `no answer within ${REQUEST_TIMEOUT_MS} ms (REQUEST_TIMEOUT_MS)`)), REQUEST_TIMEOUT_MS);
  req.signal.addEventListener("abort", () => ctl.abort(new ChatError("aborted", "client disconnected")));

  // NDJSON to the browser: delta / reset / done / error. Localhost hop, so it always streams.
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (o: object) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch {} // browser already gone
      };
      const onDelta = (text: string) => send({ type: "delta", text });
      const t0 = performance.now();
      try {
        let out: Outcome;
        try {
          out = await chatAttempt(id, messages, stream, ctl.signal, onDelta);
        } catch (err) {
          if (!stream || !(err instanceof ChatError) || !RETRYABLE.includes(err.kind)) throw err;
          log(id, "chat.fallback", { reason: err.kind, message: err.message });
          send({ type: "reset", reason: err.message });
          out = await chatAttempt(id, messages, false, ctl.signal, onDelta);
        }
        const cost = out.usage ? addUsage(out.usage) : 0;
        if (!out.usage) log(id, "chat.no_usage");
        send({ type: "done", finishReason: out.finishReason, usage: out.usage, costUsd: cost, totalUsd: totals.usd });
        log(id, "chat.ok", { ms: Math.round(performance.now() - t0), costUsd: cost, totalUsd: totals.usd });
      } catch (err) {
        const e = err instanceof ChatError ? err : new ChatError("network", String((err as any)?.message ?? err));
        if (!(err instanceof ChatError)) log(id, "chat.unexpected_error", errInfo(err));
        log(id, "chat.error", { kind: e.kind, message: e.message, ms: Math.round(performance.now() - t0) });
        send({ type: "error", kind: e.kind, message: e.detail ? `${e.message}: ${e.detail}` : e.message });
      } finally {
        clearTimeout(deadline);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      ctl.abort(new ChatError("aborted", "client cancelled"));
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

async function handleExtract(id: string, req: Request): Promise<Response> {
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) return json({ kind: "bad_request", message: "multipart field 'file' missing" }, 400);
  // Filename may itself be sensitive: log extension + size only.
  const ext = file.name.split(".").pop()?.toLowerCase();
  const t0 = performance.now();
  let res;
  try {
    res = await extractText(await file.arrayBuffer(), file.name);
  } catch (err) {
    log(id, "extract.crash", { ext, bytes: file.size, ...errInfo(err) });
    return json({ kind: "extract", message: `could not read file (corrupt?): ${(err as any)?.message ?? err}` }, 422);
  }
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    log(id, "extract.fail", { ext, bytes: file.size, ms, error: res.error });
    return json({ kind: "extract", message: res.error }, 422);
  }
  log(id, "extract.ok", { ext, bytes: file.size, ms, kind: res.kind, pages: res.pages, chars: res.text.length });
  if (res.text.length > MAX_DOC_CHARS) {
    return json({ kind: "too_large", message: `document is ${res.text.length} chars, limit is ${MAX_DOC_CHARS} (MAX_DOC_CHARS)` }, 413);
  }
  return json({ name: file.name, kind: res.kind, pages: res.pages, chars: res.text.length, text: res.text });
}

// Cheap connectivity check: list models, no tokens burned.
async function handleHealth(id: string): Promise<Response> {
  const t0 = performance.now();
  try {
    const res = await mistralFetch(id, "/v1/models", { method: "GET", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const data: any = await res.json();
    const modelAvailable = (data.data ?? []).some((m: any) => m.id === MODEL);
    return json({ ok: true, ms: Math.round(performance.now() - t0), model: MODEL, modelAvailable });
  } catch (err) {
    const e = err instanceof ChatError ? err : networkError(err);
    log(id, "health.error", { kind: e.kind, message: e.message });
    return json({ ok: false, kind: e.kind, message: e.message, ms: Math.round(performance.now() - t0) });
  }
}

// --- server ----------------------------------------------------------------------------------

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const STATIC: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/md.js": "md.js", "/img.js": "img.js" };

async function route(id: string, req: Request, path: string): Promise<Response> {
  // Drive-by protection: DNS rebinding (Host) and cross-site POSTs (Origin; curl sends none).
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");
  if (!ALLOWED_HOSTS.has(host) || (req.method === "POST" && origin !== null && !ALLOWED_ORIGINS.has(origin))) {
    log(id, "http.rejected", { host, origin });
    return new Response("forbidden", { status: 403 });
  }

  if (req.method === "GET" && STATIC[path]) return new Response(Bun.file(join(import.meta.dir, "public", STATIC[path])));
  if (req.method === "POST" && path === "/api/chat") return handleChat(id, req);
  if (req.method === "POST" && path === "/api/extract") return handleExtract(id, req);
  if (req.method === "GET" && path === "/api/health") return handleHealth(id);
  if (req.method === "GET" && path === "/api/usage") return json({ ...totals, prices, priceSource });
  return new Response("not found", { status: 404 });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // a buffered answer on a big doc can be silent for minutes; REQUEST_TIMEOUT_MS bounds it
  async fetch(req) {
    const id = newId();
    const path = new URL(req.url).pathname;
    const t0 = performance.now();
    let res: Response;
    try {
      res = await route(id, req, path);
    } catch (err) {
      log(id, "http.crash", errInfo(err));
      res = json({ kind: "server", message: String((err as any)?.message ?? err) }, 500);
    }
    log(id, "http", { method: req.method, path, status: res.status, ms: Math.round(performance.now() - t0) });
    return res;
  },
});

// Startup banner: everything needed to reason about the network path, credentials redacted.
const proxyEnv: Record<string, string> = {};
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
  if (process.env[k]) proxyEnv[k] = process.env[k]!.replace(/\/\/[^@/]*@/, "//***@");
}
log("startup", "misti", {
  url: `http://127.0.0.1:${PORT}`, bun: Bun.version, platform: process.platform, endpoint: BASE, model: MODEL,
  proxyEnv, extraCaCerts: process.env.NODE_EXTRA_CA_CERTS ?? null,
  streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS, maxDocChars: MAX_DOC_CHARS,
});
loadPrices();
