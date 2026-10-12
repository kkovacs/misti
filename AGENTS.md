# AGENTS.md — MISTI

Local, single-user Bun chat UI (think duck.ai, but local) against Mistral's EU
endpoint, with optional docx/pdf/image attachments, under a
**Zero Data Retention (ZDR)** requirement. Runs on locked-down
corporate Windows boxes behind hostile proxies.

Run: `bun install && bun server.ts` -> `http://127.0.0.1:31571`. Test: `bun test`.
Config: `.env` (see `.env.example`); defaults and constants live in `server.ts`.

## Hard constraints (do not relax without the user)

- **ZDR: stateless Mistral endpoints only.** V1 uses `/v1/chat/completions` and
  `GET /v1/models`. Never `/v1/files`, agents, batch, conversations, libraries
  (they store data). ZDR itself is enabled on the account — out of scope.
- **Topology: browser -> Bun server -> Mistral.** Direct browser calls are ruled
  out (CORS; API key would reach the browser).
- **Ship plain source.** No compiled `.exe` (trips corporate EDR), no Python, no
  system binaries (tesseract etc.). Few deps; ask before adding any.
- **Bind `127.0.0.1` only, no auth.** Host/Origin guard instead (see below).
- **No disk writes** of documents; extraction is in memory.

## Architecture & rationale

- `server.ts` is a stateless proxy. The **browser holds all conversation state**
  (doc text, images, history) and resends it every turn; the only server state is the
  in-memory cost counter. Reload / "New chat" = fresh conversation.
- Documents are "dumped", not chunked: extracted text is attached **once**, to
  the user turn after upload, so it becomes a stable prefix (Mistral prompt
  cache). No RAG in V1; the real corpus (born-digital PDFs, <~60k chars each)
  fits easily. `MAX_DOC_CHARS` caps the whole conversation (all of it is billed
  each turn) — it is cost control, not a context limit.
- `extract.ts`: docx -> mammoth, pdf -> unpdf (pdf.js text layer). Empty text
  layer = scanned PDF -> explicit error. Corrupt files throw (fail fast, accepted).
- **Images** never touch the server's extractor: the browser shrinks them
  (`img.js`, canvas -> JPEG data URL) and the user turn becomes
  `[text, image_url...]` parts; turns without images stay plain strings.
  Images are re-sent (and billed) every turn, hence the shrink and the
  per-conversation image cap.
- `public/`: vanilla JS, no framework, no build step. `md.js` / `img.js` /
  `money.js` are deliberate tiny helpers (no dependency), CommonJS-exported for
  bun tests.
- Always SSE to Mistral, NDJSON to the browser (`thinking` / `delta` / `done` /
  `error`).
  Buffered mode and the buffered fallback retry were removed on purpose: SSE
  works, and every retry was a second bill.

## Landmines

**Security / compliance**
- **Logs must never contain** the API key, document text, filenames (log
  extension + size), prompts, model output, or *any* part of a response body —
  not even error bodies. `ChatError.message` is loggable; `ChatError.detail`
  (e.g. Mistral's JSON error text) goes to the UI only. `test/server.test.ts`
  audits the log; keep it passing.
- Logs record image count/bytes only, never image data. `image_url` must be a
  `data:image/` URL — a remote URL would make Mistral fetch from a third party.
- Model output can echo document content: **never put raw text into
  `innerHTML`**. Only `renderMarkdown()` output (escape-first, http(s)-only
  links) goes there.
- Guard: reject `Host` other than `127.0.0.1:PORT`/`localhost:PORT` (DNS
  rebinding) and POSTs whose `Origin` is present and foreign (CSRF). Missing
  `Origin` is allowed on purpose so curl works; browsers always send it.

**Mistral API**
- **OCR is possible ZDR-clean, deferred to V2**: `/v1/ocr` with
  `document: {type: "document_url", document_url: "data:application/pdf;base64,..."}`
  (images: `image_url` with a data URI). There is **no** `document_base64` type
  (422). Never use `file`/`file_id` — that requires stateful `/v1/files`.
  `probe.ts` exercises this.
- `mistral-large-4` is a reasoning model: `message.content` / `delta.content`
  may be an **array of typed chunks**; keep only `type: "text"` (`textOf()`).
  Reasoning tokens are billed inside `completion_tokens` and are large
  (hundreds for "say hi").
- Reasoning **streams live**: `{type: "thinking", thinking: [text chunks]}`
  parts from ~50 ms after the headers; the last one has `closed: true` and
  shares a delta with the first answer text. A chunk carries 1 to ~4 tokens, so
  chunk count != token count; ~3 chars/token measured (`CHARS_PER_TOKEN`, `XXX`).
  The server forwards only the **size** (`{type: "thinking", n: chars}`), never
  the text; the browser drives the thinking spinner from it (flywheel: each
  token kicks it, friction slows it, so speed = token rate and a stall spins it
  down) and freezes it into "thought for 0:14 · ~320 tokens", also on a
  stopped/rolled-back turn (that reasoning was billed). Logs: `thinkingChunks`,
  `thinkingChars`, `thinkingMs` in `mistral.stream_end`.
- `mistral-large-4` has vision. Tiny images (16x16) are **silently ignored**
  (no error, no tokens); `img.js` upscales below a minimum (empirical, `XXX`).
- **Prompt caching** (verified on `mistral-large-4`, differs from the docs):
  automatic, but prompts under ~1k tokens never cache, with or without a key
  (docs claim 64). Cached counts step in ~512-token blocks, so the last few
  hundred tokens are always uncached; the first turn always shows 0. Observed
  lifetime ~3-5 min (hit at 3 min, gone at 5), and hits are not guaranteed
  even inside it — a follow-up after a long read shows 0 cached. Keep-alive
  pings were rejected (each costs 10% of the whole prefix, also while idle). The
  browser sends a random per-chat `prompt_cache_key` (new on "New chat") —
  Mistral's documented hit-rate lever; never put user data in it.
- No pricing in any API response (`/v1/pricing`, `/v1/prices` -> 404). Prices
  come from models.dev (`mistral.models[<model>].cost`) at startup, falling
  back to constants in `server.ts`. Cost = uncached input + cached input at
  `cache_read` + output.
- Money is **displayed in HUF**: models.dev prices are USD, so the rate is
  USD->HUF regardless of the invoice currency (EUR). ECB rate via
  frankfurter.dev at startup; a hardwired, dated rate if unreachable (`XXX`
  refresh it). USD, rate, date and source live in the tooltip.
- `usage` arrives only in the final SSE chunk: a stopped or broken stream is
  billed but not counted. Accepted; the counter is an estimate.
- Output limit hit -> a normal end with `finish_reason: "length"` (answer kept,
  UI says "type 'continue'"). A huge doc never translates in one answer, and
  every "continue" re-sends doc + all output so far. We send no `max_tokens`:
  limits are the model's (`mistral-large-4`: 1,048,576 context per
  `/v1/models`; 262,144 output per models.dev), so `MAX_DOC_CHARS` keeps input
  far below the context window. If the limit hits **while still reasoning**,
  `done` arrives with no text: the browser rolls the turn back (an empty
  assistant message would break every later turn) but still shows the cost.

**Streaming / timeouts** (rule: never time out a call that is generating)
- `REQUEST_TIMEOUT_MS` covers only the wait for response headers (connect,
  proxy, TLS). Generation itself is never timed — long answers (translations)
  used to die at a whole-request deadline. Mistral sends SSE headers before
  reasoning starts (verified direct: headers ~0.6 s, reasoning 14 s; still
  unverified behind the corporate proxy: compare `mistral.headers` ms vs
  `mistral.stream_end` ttfbMs).
- The idle watchdog (`STREAM_IDLE_TIMEOUT_MS`) is a generous last resort for a
  silently dead connection, not a liveness check: a buffering proxy can be
  silent a long time (direct, thinking chunks keep the stream busy). The user's Stop button is the real watchdog.
- No retries at all: every failure is a visible error. Don't add any back.
- **Stop reading at `[DONE]`.** A proxy holding the connection open afterwards
  would otherwise trip the idle watchdog.
- `Bun.serve({ idleTimeout: 0 })` is deliberate: behind a buffering proxy the
  browser gets no bytes while the model reasons, which can take minutes.
- A non-JSON error response (HTML) is treated as "proxy / not Mistral".
- Browser-side, Stop/error: streamed text **stays** in history (it was paid
  for; "continue" picks it up), marked with the reason. Only a turn with no
  text yet is rolled back (question + docs restored) — Mistral rejects empty
  assistant messages anyway. Same for a `done` with no text (see output limit).
- "New chat" aborts the in-flight turn; the `chatGen` counter stops that stale
  turn's error handling from leaking into the new chat.

**Corporate proxy** (main deployment risk; untested on the real network)
- Bun `fetch` honors `HTTP(S)_PROXY` (re-read per request). No proxy config in
  the app.
- Likely failures: (1) TLS inspection -> cert errors; fix without code via
  `NODE_EXTRA_CA_CERTS`; (2) PAC/WPAD-only proxy -> Bun goes direct; set
  `HTTPS_PROXY` manually; (3) NTLM/Kerberos auth proxy -> unsupported.
- Startup and per-call logs (proxy env, revealing response headers, TTFB, chunk
  gaps, `err.code`/`cause`) exist to diagnose exactly these. Keep them verbose.

**Testing**
- Server tests spawn the real `server.ts` against a mock Mistral with
  `--no-env-file` and `MISTI_PORT` — without `--no-env-file`, Bun auto-loads
  the real `.env` key. `MISTI_PORT` is test-only. A dead `HTTPS_PROXY` keeps
  them offline (models.dev/FX hit their fallbacks; the http mock is unaffected).
- PDF fixtures: long single lines run off the page and get clipped by pdf.js;
  use many short lines.
- `test/fixtures.ts` uses `jszip` (mammoth's transitive dep, marked `XXX`).
- Browser E2E: obscura headless (`obscura serve --port 9222
  --allow-private-network`). Its default `page-1` target has no page: connect
  to `ws://127.0.0.1:9222/devtools/browser`, `Target.createTarget`, then
  `Target.attachToTarget {flatten: true}` and send with `sessionId`.
  `upload()`, `pending`, `history`, `renderMarkdown()`, `userBubble()`,
  `assistantBubble()` (its `.think.tick(n)` / `.think.stop()`) are page
  globals, handy for staging UI states without API calls. `Page.captureScreenshot` works
  (1280x720 default; `Emulation.setDeviceMetricsOverride` for other sizes).
- obscura gaps: ignores `Emulation.setEmulatedMedia` (dark mode — inject the
  dark tokens instead), no `DataTransfer`, canvas can't decode/encode images
  (`createImageBitmap` -> 0x0, `toDataURL` -> `"data:,"`), and `transform` on
  pseudo-elements. Image shrinking must be checked in a real browser.
  `fetch` delivers a streamed body in **one read at the end**, so live
  streaming (spinner, deltas) can't be observed there — stage it with the
  globals above.
- Server tests own port 31599: a manual `MISTI_PORT=31599` server (real key)
  would answer the tests instead, and send their prompts to real Mistral.
- Don't `pkill -f "bun server.ts"` from a shell whose command line contains
  that string — it kills itself.

## V1 non-goals / V2 ideas

- Non-goals: RAG/embeddings, tools/file writing, history or cost persistence,
  transcript export (per-answer Copy = raw markdown), auth, scanned PDFs,
  proxy configuration.
- V2: OCR fallback for scanned PDFs (data URI, above); tool-based corpus
  agent; pre-send cost estimate (idea: chars/token ratio calibrated from actual
  `prompt_tokens`, input shown as no-cache upper bound, output unpredictable).

## References

- `mistral-openapi.yaml` (repo) — Mistral API reference used for this work.
- https://docs.mistral.ai/studio/conversations/advanced/prompt-caching —
  prompt caching (`prompt_cache_key`, 10% price for cached tokens).
- https://models.dev/api.json — price source.
- https://frankfurter.dev — ECB reference rates (`/v1/latest?from=USD&to=HUF`).
