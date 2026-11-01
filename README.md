# MISTI — local, ZDR-compliant AI chat

A chat interface that runs on your own machine and is used from the browser,
talking to Mistral's EU API. Meant for general chat and for analyzing documents
(.docx, .pdf) and images, under **Zero Data Retention (ZDR)**: Mistral does not
store or log either the questions or the answers.

## 1. Running it

**Prerequisites**

- [Bun](https://bun.sh)
- A Mistral API key for an account on which Mistral has **approved ZDR**
  (after approval it appears in the privacy settings of the Admin console;
  you must request it from Mistral support).

**Starting it**

```sh
cp .env.example .env        # then set MISTRAL_API_KEY=... in .env
bun install
bun server.ts
```

Then open in the browser: <http://127.0.0.1:31571>

- The server is reachable only from your own machine (`127.0.0.1`), not from
  other machines.
- Files: drag them into the window, or use "+ Attach"; screenshots: Ctrl+V.
- "New chat" or a page refresh = a clean slate; the conversation is not kept
  anywhere.
- The cost is displayed in HUF (an estimate); hovering over it shows the USD
  amount and the exchange rate too.

**Corporate network, proxy**

- If there is a proxy: `HTTPS_PROXY=http://proxy.company:8080` in `.env`.
- If your company inspects TLS traffic (certificate error at startup):
  `NODE_EXTRA_CA_CERTS=C:\path\to\corporate-root-ca.pem`.
- The **Healthcheck** button verifies the connection with a probe call
  (e.g. after switching VPNs).
- On error the console writes a detailed but content-free log — send that with
  the bug report.

Tests: `bun test` (runs without network and without an API key).

## 2. Why is this the best option for ZDR and the EU?

### European provider, directly

- **Mistral AI is a French, Europe-headquartered company**; MISTI calls the EU
  endpoint (`api.eu.mistral.ai`), directly, without a cloud-provider
  intermediary.
- The American providers (OpenAI, Anthropic, Google) also offer EU data
  handling, but as US parent companies the question of US government access
  (e.g. the US CLOUD Act) arises even with EU data storage, and the EU
  processing is often implemented through yet another intermediary (AWS,
  Google Cloud). With Mistral there is a single, European contracting party
  (the subcontractors it uses are listed by the Mistral Trust Center).

### ZDR: only the endpoints it applies to

Mistral's ZDR applies **only to "stateless" API calls**; features that involve
storage (Agents, Batch, Conversations, Libraries, `/v1/files`, the Le Chat
product) are **not** covered. MISTI therefore strictly uses only these:

- `/v1/chat/completions` — the conversation, and
- `/v1/models` — connection check.

Documents are **never uploaded** to Mistral as files: the text is extracted on
your own machine, and only the text goes in the request. Images also travel
inside the request (embedded), not as separately stored files.

### Nothing is kept — not here either

- The server **never writes documents to disk**, and stores no conversation;
  the history lives only in the browser tab's memory.
- The log **never** contains the API key, document text, filenames, questions,
  answers or images — only sizes, times, error codes. An automated test
  verifies this.
- It is accessible only from the local machine, and is protected against
  abuse via the browser (a foreign website cannot call it in your name).

### No ZDR at consumer level in any other way

Popular chat apps (ChatGPT, Claude.ai, Gemini, and even Mistral's own Le Chat)
**do not offer ZDR** in their consumer form; ZDR is available everywhere only
at the API level, with separate approval. But a developer API is not something
colleagues can conveniently use. **MISTI fills exactly this gap:** a familiar
chat interface on top of the ZDR API.

### Transparency: what else leaves the machine?

At startup two **content-free** requests: the model prices
([models.dev](https://models.dev)) and the USD/HUF exchange rate (ECB, via the
[frankfurter.dev](https://frankfurter.dev) service). Neither contains any user
data; if they are unreachable, built-in values are used instead.

### Limitations

- ZDR is a **setting of the Mistral account**, not of MISTI: without approved
  ZDR, Mistral (per the service's default settings) may temporarily retain
  requests for abuse monitoring. With ZDR it does not store even that.
- The short-lived (a few minutes) prompt cache on Mistral's side is part of
  the processing; the Mistral Trust Center provides details about it.
- Scanned PDFs (without a text layer) are not handled by the current version.

## Sources

- Mistral — Zero data retention:
  <https://docs.mistral.ai/admin/monitor-comply/zero-data-retention>
- Mistral — Prompt caching:
  <https://docs.mistral.ai/studio/conversations/advanced/prompt-caching>
- OpenAI — Data residency in Europe:
  <https://openai.com/index/introducing-data-residency-in-europe/>
- Anthropic — API and data retention:
  <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention>
