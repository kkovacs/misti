# SPEC — MISTI: ZDR-compliant local document-analysis UI

## Purpose

A locally running, Bun-based web UI for document work (Q&A, summarization,
extraction, comparison) against Mistral's EU inference endpoint, under a
Zero Data Retention (ZDR) compliance requirement.

## Hard constraints

- **ZDR**: only stateless Mistral endpoints. Never `/v1/files` or any stateful
  API (agents, batch, conversations, libraries). Documents are never
  "uploaded" to Mistral; only extracted text is sent in a stateless request
  body. (ZDR itself is active on the Mistral account — out of scope here.)
- **Endpoint**: `https://api.eu.mistral.ai` (code constant fallback if not in .env)
- **Model**: `mistral-large-4` (code constant if not in .env; confirmed present via
  `GET /v1/models`)
- **Bind**: `127.0.0.1:31571`, single user, no auth (see Local security)
- **Topology**: browser -> Bun server -> Mistral. Direct browser -> Mistral is
  ruled out (CORS; API key would live in the browser). The API key, cost
  counter, streaming and fallback logic all live server-side.
- **Runtime**: plain source directory — ship source only, no bundled
  node_modules (registry is reachable). `bun install` + `bun server.ts` on the
  box. No compiled `.exe` (trips corporate EDR). No Python, no system
  binaries, no tesseract.

## Compliance (ZDR)

Stateless endpoints — ZDR-compliant, i.e. "in scope" for the ZDR rule
(from Mistral docs). V1 product scope uses only `/v1/chat/completions`
(+ `GET /v1/models` for health):

- `/v1/chat/completions`, `/v1/fim/completions`, `/v1/embeddings`
- `/v1/moderations`, `/v1/chat/moderations`
- `/v1/classifications`, `/v1/chat/classifications`
- `/v1/ocr`, `/v1/audio/speech`, `/v1/audio/transcriptions`

Stateful — out of scope (files stored): agents, batch, conversations,
libraries, **`/v1/files`**, Vibe Work, Chat (the stateful chat product —
distinct from the stateless `/v1/chat/*` endpoints above).

## Mistral OCR — ZDR-clean via data: URI, deferred to V2

`/v1/ocr` is stateless and accepts local files inline as base64 **data URIs**
(verified live, HTTP 200):

- PDF: `document: { type: "document_url", document_url: "data:application/pdf;base64,..." }`
  -> synthetic "HELLO ZDR" PDF returned `## HELLO ZDR`
- Image: `document: { type: "image_url", image_url: "data:image/png;base64,..." }`

(An earlier 422 came from a non-existent `document_base64` type in `probe.ts`.)
Never use the `file` / `file_id` input — it requires stateful `/v1/files`.

**V1**: extraction stays fully local; scanned PDFs get an error.
**V2**: OCR as fallback for PDFs with no text layer.

## Config (.env)

- `.env` requires **`MISTRAL_API_KEY`**. Optional overrides: endpoint,
  model, `STREAM_IDLE_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `MAX_DOC_CHARS`.
- **No proxy configuration in V1** (Bun reads `HTTP(S)_PROXY` from env on its
  own; see Corporate proxy).

## Architecture

```
misti/
├─ server.ts        Bun.serve — static public/ + POST /api/extract + POST /api/chat
│                   + GET /api/health + GET /api/usage
├─ extract.ts       docx/pdf bytes -> text; "no text layer" guard
├─ probe.ts         standalone de-risking probe (OCR via data: URI + chat streaming)
├─ mistral-openapi.yaml  Mistral API reference (source-noted in header)
├─ public/
│  ├─ index.html    chat box + drag-drop docx/pdf + streaming toggle + health button
│  │                + cost-since-start + copy-to-clipboard
│  ├─ app.js        vanilla JS (no framework); holds all conversation state
│  ├─ md.js         tiny dependency-free Markdown renderer (escape-first, XSS-safe)
│  └─ style.css     minimal dark UI
├─ test/            bun tests (see Testing)
├─ .env             MISTRAL_API_KEY + optional overrides (gitignored)
├─ .env.example     all knobs, documented
└─ .gitignore       .env, node_modules
```

- **`POST /api/extract`**: browser uploads the dropped file (multipart);
  server extracts in memory and returns the text. Nothing is written to disk.
  `extract.ts` takes a buffer + filename instead of a path.
- **`POST /api/chat`**: browser sends the full conversation (doc text +
  history) each turn; server proxies to Mistral. The server holds no
  conversation state — only the cost counter.

## Document handling

- **Approach: dump documents.** Attach docx/pdf -> extract -> full text goes
  into the conversation once, at the start (stable prefix -> Mistral prompt
  cache applies on later turns). No chunking/RAG; a tool-based corpus agent
  is deferred to V2.
- **No tools in V1.** No file writing.
- **docx** -> `mammoth` (strict zip parser; corrupt files fail fast — accepted)
- **PDF** -> `unpdf` (pdf.js text layer)
- **Scanned PDF** (no text layer) -> clear error: "scanned, not supported in V1"
- **No chunking, no RAG**: full extracted text goes into the prompt.
  `MAX_DOC_CHARS` guard (default ~400k) with a fail-fast "too large" error.
  (`mistral-large-4` has a 1M-token context, so this guard is cost control,
  not a context limit.)
- **Copy to clipboard** button on every assistant response — copies the raw
  markdown.
- Answers are rendered as Markdown by `public/md.js` (headings, lists, tables,
  code, quotes, bold/italic, http(s) links). Everything is HTML-escaped first,
  because model output can echo document content.
- Reasoning output (`thinking` content chunks) is dropped; only `text` chunks
  are shown.
- On a failed turn the client rolls back: question and documents are restored
  for a retry.
- pdf.js `TT: undefined function` warning silenced in the server.

## Dependencies

- `mammoth` — docx text
- `unpdf` — PDF text layer
- `@types/bun` — dev types

## Cost tracking

- No pricing in the inference responses (model metadata + chat responses
  carry `usage` tokens only — no currency).
- Price sourced from models.dev on start; on 5s timeout fall back to
  hardcoded constants (USD/1M tokens): input 0.68, cache-read 0.07,
  output 2.09. Reasoning tokens are assumed to land inside
  `completion_tokens` (no separate rate).
- Cost is computed locally: `usage` tokens x price constants.
- **Cache-aware**: Mistral reports `usage.prompt_tokens_details.cached_tokens`;
  cached input is billed at the reduced cache-read rate.
  cost = (uncached_prompt x input + cached x cache-read + completion x output) / 1M
- Counter is **in-memory only** (since server start; resets on
  restart/reload). No persistence — consistent with stateless V1.
- **Known undercount**: `usage` arrives only in the final stream chunk, so a
  truncated stream that triggers a retry is billed by Mistral but not
  counted. Accepted — the counter is an estimate.

## Streaming & resilience (corporate-hostile network)

- Streaming on by default, progressive rendering.
- **Auto-fallback**: on stream error OR truncated stream (no `[DONE]` sentinel)
  -> retry once with `stream: false`. API errors (4xx/5xx JSON) are not retried.
- Reading stops at `[DONE]` — a proxy holding the connection open afterwards
  must not trip the idle watchdog into a needless (billed) retry.
- **Safety timeouts** (env-tunable; generous, never latency-triggered into a
  false fallback):
  - `STREAM_IDLE_TIMEOUT_MS` (default 60_000): no bytes for this long ->
    abort + buffered retry. Hang detector only.
  - `REQUEST_TIMEOUT_MS` (default 300_000): hard ceiling for the Mistral call;
    fail fast with a clear error.
- **Manual "no streaming" toggle** in the UI, for proxies that actively mangle
  `text/event-stream`.
- **Distinct errors**: network/proxy ("check VPN/proxy") vs. Mistral API error
  vs. document too large.
- Health button lets the user re-test connectivity after a VPN change without
  burning a full document request (call the "model list" endpoint).

## Corporate proxy (main deployment risk)

Bun `fetch` honors `HTTP_PROXY`/`HTTPS_PROXY`. Likely failure modes, most
likely first:

1. **TLS inspection** — proxy re-signs with a corporate root CA Bun doesn't
   trust (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` etc.). Fix without code:
   `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`.
2. **PAC/WPAD-only proxy** — no env vars set, Bun goes direct and is blocked.
   Fix: set `HTTPS_PROXY` manually.
3. **Authenticating proxy (NTLM/Kerberos)** — not supported by Bun. No V1 fix.

Logging (below) must make it obvious which of these happened.

## Logging

Verbose, to **stdout only**. One line per event, each tagged with a request id.

- **Startup**: Bun version, endpoint, model, which proxy env vars are set
  (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, lowercase variants; credentials
  redacted), whether `NODE_EXTRA_CA_CERTS` is set, price source (models.dev
  vs. fallback).
- **Per Mistral call**: start (endpoint, model, stream on/off, prompt chars);
  time to response headers; HTTP status; proxy-revealing response headers
  (`via`, `server`, `content-type`, `x-cache`, Mistral request id);
  time to first byte; chunk count + total bytes; longest gap between chunks;
  `[DONE]` seen or not; `finish_reason`; `usage`; fallback triggered + reason;
  total duration.
- **Errors**: `err.name`, `err.code`, `err.cause` (distinguishes TLS / DNS /
  connection refused / timeout / abort). Non-JSON or unexpected responses:
  status, content-type, body length.
- **Local requests**: method, path, status, duration; rejected Host/Origin.
- **Never logged**: API key, document text, filenames (extension + size only),
  prompts, model output, or any part of a response body (not even error
  bodies). A Mistral JSON error message (e.g. "Unauthorized") is shown in the
  UI only.

## Local security

No auth, but guard against drive-by browser attacks (CSRF, DNS rebinding)
spending the API key:

- Reject (403) any request whose `Host` is not `127.0.0.1:31571` or
  `localhost:31571`.
- Reject (403) any POST whose `Origin` header is present and is not
  `http://127.0.0.1:31571` or `http://localhost:31571`.

## Testing

`bun test` (no network, no API key needed):

- `test/extract.test.ts` — pdf, scanned pdf, docx, corrupt docx, unsupported
  type (synthetic files built in `test/fixtures.ts`).
- `test/md.test.ts` — renderer output + escaping/XSS cases.
- `test/server.test.ts` — spawns the real `server.ts` (`MISTI_PORT=31599`,
  `--no-env-file`) against a mock Mistral: Host/Origin guard, health, extract,
  streaming + buffered chat, truncated / silent / lingering streams, API error,
  HTML-from-proxy, deadline, size guard, cost totals, and a log audit (no key,
  doc text, filenames or bodies in stdout).

`MISTI_PORT` exists only for tests; production stays on 31571.

## V1 non-goals

- No chunking/RAG, no embeddings
- No tools, no file writing
- No history persistence (stateless; reload = fresh)
- No export of the chat transcript (copy-to-clipboard per response instead)
- No cost persistence (in-memory counter only)
- No auth, but listen on localhost
- No scanned-PDF support (error only; OCR is V2)
- No corrupt-file recovery (fail fast only)
- No proxy configuration, no Windows-registry/PAC proxy auto-read; rely on
  Bun's env-var proxy support

## Open questions

- None currently.

## Verified so far

- Chat streaming against the EU endpoint works; SSE plumbing confirmed.
- `mistral-large-4` exists on the EU endpoint.
- docx: `WORKSHOP_Moderalas.docx` -> 11,865 chars, clean Hungarian.
- PDF: 12 real born-digital docs, 18k-57k chars each (18-93 pages); largest
  ~15k tokens -> stuff-the-prompt is safe for this corpus.
- Bun `fetch` honors `HTTP_PROXY`/`HTTPS_PROXY` and re-reads per request
  (local test).
- No cost/pricing field in any response: `/v1/pricing` + `/v1/prices` -> 404;
  chat completion returns `usage` only (`prompt_tokens`, `completion_tokens`,
  `prompt_tokens_details.cached_tokens`, `service_tier`).
- `/v1/ocr` accepts base64 data URIs for PDF (`document_url`) and images
  (`image_url`) — HTTP 200 (V2 path).
- Reasoning tokens are billed inside `completion_tokens`: "Say hi in 3 words"
  -> 435 completion tokens. Expect output cost well above the visible text.
- Failure paths against real targets: connection refused, self-signed TLS
  (`DEPTH_ZERO_SELF_SIGNED_CERT` + CA hint), HTML 405 from a non-Mistral host,
  dead proxy, idle-timeout fallback, request deadline — each produces the right
  error kind and a diagnosable log line.
- Browser E2E (obscura headless, CDP, `--allow-private-network`): load, health,
  PDF upload, streamed answer grounded in the doc, follow-up turn using history.
