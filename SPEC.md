# SPEC — MISTI: ZDR-compliant local document-analysis UI

## Purpose

A locally running, Bun-based web UI for document work (Q&A, summarization,
extraction, comparison) against Mistral's EU inference endpoint, under a
Zero Data Retention (ZDR) compliance requirement.

## Hard constraints

- **ZDR**: only stateless Mistral endpoints. Never `/v1/files` or any stateful
  API (agents, batch, conversations, libraries). Documents are never
  "uploaded"; only extracted text is sent in a stateless request body.
- **Endpoint**: `https://api.eu.mistral.ai` (code constant)
- **Model**: `mistral-large-4` (code constant; confirmed present via
  `GET /v1/models`)
- **Bind**: `127.0.0.1:31571`, single user, no auth
- **Runtime**: plain source directory — ship source only, no bundled
  node_modules (registry is reachable). `bun install` + `bun server.ts` on the
  box. No compiled `.exe` (trips corporate EDR). No Python, no system
  binaries, no tesseract.

## Compliance (ZDR)

Stateless endpoints — in scope (from Mistral docs):

- `/v1/chat/completions`, `/v1/fim/completions`, `/v1/embeddings`
- `/v1/moderations`, `/v1/chat/moderations`
- `/v1/classifications`, `/v1/chat/classifications`
- `/v1/ocr`, `/v1/audio/speech`, `/v1/audio/transcriptions`

Stateful — out of scope (files stored): agents, batch, conversations,
libraries, **`/v1/files`**, Vibe Work, Chat.

## Mistral OCR — ruled out for local files

Probed live (`/v1/ocr` -> 422) and confirmed against official docs. The
`document` input field accepts only:

- `document_url` — file at a public URL Mistral fetches
- `image_url` — image at a public URL
- `file` — `file_id` from the stateful `/v1/files` API (violates ZDR)

No base64 input exists (`image_base64` is response-only). Local files
therefore have no ZDR-clean path into OCR. **OCR is dropped; extraction is
fully local.**

## Config (.env)

- `.env` contains **only `MISTRAL_API_KEY`**. Nothing else.
- Model, base URL, and port are code constants (change in code, not in `.env`).
- **No proxy configuration in V1.**

## Architecture

```
misti/
├─ server.ts        Bun.serve — static public/ + POST /api/chat + GET /api/health + GET /api/usage
├─ extract.ts       [done] docx/pdf -> text; "no text layer" guard
├─ mistral-openapi.yaml  Mistral API reference (source-noted in header)
├─ public/
│  ├─ index.html    chat box + drag-drop docx/pdf + streaming toggle + health button + cost-today + copy-to-clipboard
│  ├─ app.js        vanilla JS (no framework)
│  └─ style.css     minimal dark UI
├─ .env             MISTRAL_API_KEY only (gitignored)
└─ .gitignore       .env, node_modules
```

## Document handling

- **Approach: Option A (dump, no tools).** Attach docx/pdf -> extract once ->
  hold text client-side as named documents -> dump full text into each turn.
  Re-asking does not re-extract or re-upload. No tool-calling, no local
  workspace, no markdown files (deferred to V2 as a tool-based corpus agent).
- **docx** -> `mammoth` (strict zip parser; corrupt files fail fast — accepted)
- **PDF** -> `unpdf` (pdf.js text layer)
- **Scanned PDF** (no text layer) -> clear error: "scanned, not supported in V1"
- **No chunking, no RAG**: full extracted text goes into the prompt.
  `MAX_DOC_CHARS` guard (default ~400k) with a fail-fast "too large" error.
  (`mistral-large-4` has a 1M-token context, so this guard is cost control,
  not a context limit.)
- **Copy to clipboard** button on every assistant response. No export-to-file.
- pdf.js `TT: undefined function` warning silenced in the server.

## Dependencies

- `mammoth` — docx text
- `unpdf` — PDF text layer
- `@types/bun` — dev types

## API

```
POST /api/chat    multipart: message + optional docx/pdf files + stream flag
                  -> extract text -> chat.completions -> SSE tokens to client
                     (or JSON when stream=false). Requests
                     stream_options.include_usage=true so token usage arrives
                     even on the streaming path.
GET  /api/health  cheap stateless ping (models list), short timeout;
                  wired to a "Test connection" button.
GET  /api/usage   in-memory totals (tokens + estimated cost) since server
                  start; drives the "cost today" counter.
```

## Cost tracking

- No pricing in the inference responses (model metadata + chat responses
  carry `usage` tokens only — no currency). Model price is the hardcoded
  constants below (sourced from models.dev).
- Cost is computed locally: `usage` tokens x hardcoded price constants.
- **Cache-aware**: Mistral reports `usage.prompt_tokens_details.cached_tokens`;
  cached input is billed at the reduced cache-read rate. Three constants:
  `INPUT_PRICE_PER_1M`, `CACHED_INPUT_PRICE_PER_1M`, `OUTPUT_PRICE_PER_1M`.
  cost = (uncached_prompt x input + cached x cached-input + completion x output) / 1M
- **Prices** (USD per 1M tokens, from models.dev, public list):
  - input `0.68`, output `2.09`, cache-read `0.07` for `mistral-large-4`.
  - Constants editable at the top of server.ts. Note: `billing_model_name` is
    `mistral-large-4-0-launch-discount`, so the org's actual plan price may
    differ from public list.
- Counter is **in-memory only** ("today" = since server start; resets on
  restart/reload). No persistence — consistent with stateless V1.

## Streaming & resilience (corporate-hostile network)

- Streaming on by default, progressive rendering.
- A buffering proxy is fine: the whole SSE body may arrive as one burst at the
  end; the client renders it then. Progressive display is the only casualty.
- **Auto-fallback**: on stream error OR truncated stream (no `[DONE]` sentinel)
  -> retry once with `stream: false`.
- **Safety timeouts** (env-tunable; generous, never latency-triggered into a
  false fallback):
  - `STREAM_IDLE_TIMEOUT_MS` (default 60_000): no bytes for this long ->
    abort + buffered retry. Wide enough that slow prefill on a large doc never
    trips it; only fires on a genuinely silent hang.
  - `REQUEST_TIMEOUT_MS` (default 300_000): hard ceiling for the Mistral call;
    fail fast with a clear error.
- **Manual "no streaming" toggle** in the UI, for proxies that actively mangle
  `text/event-stream`.
- **Distinct errors**: network/proxy ("check VPN/proxy") vs. Mistral API error
  vs. document too large.
- Health button lets the user re-test connectivity after a VPN change without
  burning a full document request.

## V1 non-goals

- No chunking/RAG, no embeddings
- No history persistence (stateless; reload = fresh)
- No tool-calling / local agent workspace (V2)
- No export-to-file (copy-to-clipboard per response instead)
- No cost persistence (in-memory counter only)
- No auth
- No scanned-PDF support (error only)
- No corrupt-file recovery (fail fast only)
- No proxy configuration, no Windows-registry proxy auto-read

## Verified so far

- Chat streaming against the EU endpoint works; SSE plumbing confirmed.
- `mistral-large-4` exists on the EU endpoint.
- docx: `WORKSHOP_Moderalas.docx` -> 11,865 chars, clean Hungarian.
- PDF: 12 real born-digital docs, 18k-57k chars each (18-93 pages); largest
  ~15k tokens -> stuff-the-prompt is safe for this corpus.
- Bun `fetch` honors `HTTP_PROXY`/`HTTPS_PROXY` and re-reads per request
  (local test) — relevant only if proxy support is ever added (V2).
- No cost/pricing field in any response: `/v1/pricing` + `/v1/prices` -> 404;
  chat completion returns `usage` only (`prompt_tokens`, `completion_tokens`,
  `prompt_tokens_details.cached_tokens`, `service_tier`).

## Open items

- Confirm `mistral-large-4` is ZDR-enabled on the org's plan (a successful call
  does not prove ZDR coverage).
- Confirm org plan pricing matches models.dev public prices (input 0.68 /
  output 2.09 / cache-read 0.07 $/1M); `billing_model_name` showed a launch
  discount, so actual cost may be lower.
- Scanned-PDF share unknown; handled as an error for V1, revisit if scans show up.
- Proxy/VPN: deferred. If the box needs an explicit proxy, revisit — Bun honors
  `HTTPS_PROXY` but does not read the Windows system proxy (registry).
