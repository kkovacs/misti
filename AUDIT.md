# MISTI — Code Review (senior, "ponytail" pass)

Reviewed: `server.ts`, `extract.ts`, `public/{app,md,img,money}.js`, `public/index.html`, `public/style.css`, `test/*.ts`. All 43 tests pass.

The code is tight for a V1 ZDR proxy. Most of what I have to say is not "this is broken" but "this would bite someone later." Findings are ordered by seriousness.

---

## Critical — please address

### 1. Numeric env vars silently become `NaN`, disabling guards

`server.ts:8–14`

```ts
const PORT = Number(process.env.MISTI_PORT ?? 31571);
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS ?? 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 300_000);
const MAX_DOC_CHARS = Number(process.env.MAX_DOC_CHARS ?? 400_000);
```

A typo or a non-numeric value (`MAX_DOC_CHARS=400k`, `STREAM_IDLE_TIMEOUT_MS=abc`) yields `NaN`. Concrete consequences:

- `MAX_DOC_CHARS = NaN`: `chars > NaN` is always `false`. **The cost-control guard at `server.ts:330` is bypassed.** A user can send an arbitrarily large conversation; Mistral charges per token. This is the most concrete money risk in the project.
- `STREAM_IDLE_TIMEOUT_MS = NaN`: `setTimeout(fn, NaN)` is treated as ~1 ms (Node warns "TimeoutNaNWarning"). Every streaming call immediately falls back to buffered. UX collapses.
- `REQUEST_TIMEOUT_MS = NaN`: same — every request times out after 1 ms.
- `PORT = NaN`: `Bun.serve({ port: NaN })` would fail to bind — server won't start.

Fix with a small helper:

```ts
function numEnv(name: string, fallback: number, min = 0): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
}
const STREAM_IDLE_TIMEOUT_MS = numEnv("STREAM_IDLE_TIMEOUT_MS", 60_000, 1);
const REQUEST_TIMEOUT_MS      = numEnv("REQUEST_TIMEOUT_MS",      300_000, 1);
const MAX_DOC_CHARS           = numEnv("MAX_DOC_CHARS",           400_000);
```

(`MAX_DOC_CHARS = 0` is a legitimate "no docs" setting, so allow 0 for that one.)

### 2. `MAX_DOC_CHARS` is used as both per-doc and per-conversation limit — they conflict

`extract.ts` (`handleExtract`) accepts a single document up to `MAX_DOC_CHARS` (400k). `handleChat` rejects a *conversation* (history + question) above `MAX_DOC_CHARS`. But once a doc is in `history`, it is re-sent every turn, so:

- User uploads one ~400k-char PDF, gets it back, asks a follow-up → the second turn is already 400k + assistant reply → 413 `too_large`.
- Net effect: with a doc at the per-file limit, the user gets exactly **one** turn. The UI shows no warning.

Either:
- Halve the per-doc limit so that one file + one short answer fits (`MAX_DOC_CHARS_PER_DOC = MAX_DOC_CHARS / 2`), or
- Show a hint in the UI ("after a doc this size you only get one turn"), or
- Decouple the two limits (`MAX_DOC_CHARS` for total, `MAX_SINGLE_DOC_CHARS` for one).

The current "one cap, two meanings" design is the bug.

### 3. Buffered-fallback share the deadline with the streaming attempt

`handleChat` sets `deadline = setTimeout(..., REQUEST_TIMEOUT_MS)` **once** before `chatAttempt`. On a `RETRYABLE` failure (`truncated`/`idle`/`network`/`bad_response`) the buffered retry runs with `stream=false` and the same `ctl.signal` — but the deadline is not reset.

In a slow-upstream scenario: streaming takes ~290 s, buffered retry would need ~60 s, total ~350 s > 300 s = `REQUEST_TIMEOUT_MS`. The buffered retry dies with `timeout`, the user sees an error, and the streamed attempt was already paid for.

Fix: clear and re-arm `deadline` around the buffered retry, or extend the deadline by `REQUEST_TIMEOUT_MS` on fallback. Both keep the total wall-clock bounded.

### 4. Buffer for SSE parsing is unbounded

`chatAttempt` (`server.ts:226–234`) accumulates `buf += dec.decode(r.value, { stream: true })` until a `\n` is seen. There is no upper bound. If a misbehaving (or hostile) upstream sends a single SSE line without `\n`, the buffer grows until OOM. The idle watchdog only resets on bytes arriving — a continuous flow of bytes without `\n` does *not* trip it.

For the localhost→localhost hop this is theoretical; but if a corporate middlebox buffers and rewrites, a single huge line is plausible. Cap `buf` (e.g., reject when > 1 MiB without finding a newline) and treat it as `bad_response` / retryable.

### 5. `renderMarkdown` is invoked on the full accumulated string per SSE delta

`public/app.js:166`: `ui.text.innerHTML = renderMarkdown(answer);` for every delta. Cost is O(n) per delta, n deltas → **O(n²)** to render one long answer. With Mistral producing dozens of small deltas for long completions, the main thread pegs.

For V1 this is invisible; for a 10k-token answer with 200 deltas it's already a few hundred ms of jank. Consider incremental parsing (block-aware, only re-parse the tail), or throttle re-renders (e.g., via `requestAnimationFrame`).

---

## Notable — should fix

### 6. `idle` controller is created in buffered mode and never used

`chatAttempt` always builds `const idle = new AbortController()` and the composed `signal = AbortSignal.any([outer, idle.signal])`, even when `stream=false` and `arm()` will never arm a watchdog. Tiny, but it's the kind of "we might need this later" scaffolding that bit-rots. Gate it on `stream`:

```ts
const idle = stream ? new AbortController() : null;
const signal = idle ? AbortSignal.any([outer, idle.signal]) : outer;
```

### 7. `errInfo(err: any)`, `networkError(err: any)`, `okPart = (p: any) => …`, `okMsg = (m: any) => …`, `textOf(content: unknown)` filtering with `(c: any)`

`any` defeats type-safety exactly where validation matters — at the trust boundary with the browser. Replace with `unknown` + narrowing:

```ts
function isTextPart(p: unknown): p is { type: "text"; text: string } { … }
function isImagePart(p: unknown): p is { type: "image_url"; image_url: string } { … }
```

Same goes for the `as any` chains inside `handleChat`'s catch (`(err as any)?.message`) and `errInfo`. The validator pattern already lives in the file — finishing the job removes the last `any`s.

### 8. `revealingHeaders` regex matches `.*request-id` and `.*correlation-id` — overly permissive

`server.ts:50`: `/^(via|server|content-type|content-length|x-cache|.*request-id|.*correlation-id|proxy-.*|x-squid.*|x-bluecoat.*|x-zscaler.*)$/i`

`.*request-id` is a wildcard that matches **any** header ending in `request-id`, including things like `cookie-request-id` or `set-cookie-request-id`. Use the explicit upstream patterns the comment alludes to: `^(x|x-mistral)-request-id$`, `^x-correlation-id$`, etc. Or enumerate `["x-request-id","x-correlation-id","x-mistral-request-id",…]`. As written, every header in the response is logged except those with `via`, `server`, etc. — but the inverse intent was "log only the revealing ones."

### 9. Test `usage accumulates over successful calls` is order-coupled

`test/server.test.ts:159–167`:

```ts
expect(u.calls).toBe(7); // stream, 2x cacheKey, buffered, truncate-retry, hang-retry, linger
expect(u.promptTokens).toBe(700);
expect(u.cachedTokens).toBe(280);
```

The comment enumerates which earlier tests contributed. Adding or reordering a test silently breaks this assertion with a meaningless number ("expected 7 to be 8"). Two fixes:

- Compute the expected numbers from the actual test ordering at run time, not as a hard-coded constant, **or**
- Snapshot the totals right before the test runs and assert `delta(snapshot, now) == expected_delta`.

Better: capture the totals at the start of the test block and assert the delta, so reordering tests doesn't break it.

### 10. The buffered-retry "lingering [DONE]" test re-uses the same connection

`test/server.test.ts:48–58`: the LINGER path keeps the connection open after `[DONE]`. The test relies on the server's `reader.cancel()` closing the reader. That's correct, but:

- If the server *fails* to cancel (e.g., a future refactor moves the cancel), the test would still pass because the mock `LINGER` eventually times out client-side and the server reads `r.done`. The "no false fallback" property is asserted only by `evs.map(e => e.type)` — which wouldn't include a `reset` if the fallback *did* fire. So the test does cover it, but it doesn't fail loudly on a regression where cancel is removed and the server hangs on `r.done`.
- Add an upper bound to the test (e.g., `Promise.race([chat(), Bun.sleep(2000).then(() => { throw new Error("hung") })])`). Today the test relies on the upstream mock closing eventually.

### 11. `STREAM_IDLE_TIMEOUT_MS` default of 60 s is too long for the UX

The streaming UI is meant to feel live. If Mistral stalls silently for 60 s before the buffered fallback fires, the user stares at a frozen spinner for a full minute. The corporate-proxy-forensics argument that justifies the long timeout (the AGENTS.md "landmines" section) is about *the whole request*, not the streaming → buffered switch. A 15–20 s default would catch real stalls without making the proxy's long-buffered responses look like failures. Configurable, so power users can still set it higher.

### 12. Hardcoded `usdHuf` fallback in `server.ts:275` carries `// XXX refresh`

`{ usdHuf: 325.79, date: "2026-10-09", source: "hardwired" }`. The date "2026-10-09" is in the future relative to typical project context — fine for a constant, but the comment is an open maintenance ack. Acceptable for V1; consider sourcing from ECB's CSV in repo (one fewer runtime dependency on `frankfurter.dev`) if the rate matters.

---

## Minor — YAGNI, smells, simplifications

### 13. `extract.ts` still has a CLI entrypoint (`if (import.meta.main)`)

`extract.ts:33–43` keeps a `bun extract.ts <file>` spike. `probe.ts` was correctly removed in commit `602929e` ("Not needed anymore") for the same reason. The CLI block is dead code in the server; either keep it deliberately as a documented dev tool (and ship a "Debug" note in AGENTS.md) or delete it.

### 14. `/api/usage` exposes the running cost to anyone who can reach localhost

`server.ts:442`. Fine for a single-user box, but worth a one-line note in AGENTS.md (or a future `Bind 127.0.0.1 only` reminder). It already lives behind the Host/Origin guard, so the actual exposure is "anyone on this machine" — but a curious `curl` from a CI worker or another user on a shared box could read accumulated USD.

### 15. `imageBytes` is computed but never guards anything

`measure()` counts image URL string length into `imageBytes`. Only `images` (count) is checked against `MAX_IMAGES`. Either drop `imageBytes` from `measure()` or use it for a byte budget (e.g., 8 MB total inline data URLs per chat). Today it's purely noise in the log.

### 16. `idle.abort` reason is the second arg of `setTimeout`'s callback, but `AbortController.abort` is fine with non-`DOMException` reasons

`server.ts:165` passes a `ChatError` instance — works. But `AbortController.abort()` raises a `TypeError` if the reason is *not* an `Error` and the signal is consumed in certain platforms. In Bun 1.4 this is fine; in stricter Node runtimes it can become a footgun if the abstraction is ever lifted. Wrap reasons in `new Error(...)` if you want portability, or document the Bun-only assumption.

### 17. `revealingHeaders` is also read on success responses, which means the log line for `/v1/health` (a successful `GET /v1/models`) includes the upstream's request-id. That's intentional forensics. But it also logs `content-type` and `content-length` for the body — those are usually not sensitive, fine — but if Mistral ever reflects cookies in a response, the regex doesn't filter them out (cookies aren't in the regex). Unlikely; mention only so the next reader doesn't add a "but also log `set-cookie`" change.

### 18. `okMsg` allows user content as `""` (empty string)

`server.ts:130` checks the shape, not the length. Mistral's API tolerates empty user content, so this is benign — just noting that the validation is shape-only, not content-quality.

### 19. `dropzone` "dragleave" check uses `!e.relatedTarget`

`public/app.js:262` — fires when the cursor leaves the document, but `relatedTarget` is also `null` when entering certain chrome (e.g., browser scrollbars). Not a correctness bug (the overlay state is cosmetic), but flickers can occur. Use a counter pattern or check `e.relatedTarget === null || e.relatedTarget.nodeName === "HTML"`.

### 20. `setInput` grows the textarea every time `grow()` is called

`public/app.js:228–235` — `t.style.height = "auto"` then `t.style.height = scrollHeight + "px"`. This causes a layout reflow on every keystroke. For long pastes it can be janky. A single rAF debounce would smooth it.

### 21. CSS uses `color-mix(in srgb, var(--bg) 85%, transparent)` for the drop overlay

`public/style.css:91`. Modern but unsupported in older browsers (the audience here is "locked-down corporate Windows" — IE/old Edge may not have it). Worth a fallback or a `@supports` gate.

### 22. `misti.bat` polls with `ping -n 2` in a `for /l` loop

`misti.bat:36` — works, but `curl -s -o nul` polls /api/usage every ~2 s for up to 30 iterations. If the server takes >60 s to start (slow first `bun install`), the loop dies and `bun server.ts` runs without opening the browser. Use a longer total budget, or open the browser after the first 200 OK (which is what the loop already does — but cap retries, not wall time).

### 23. The `idle.signal` is composed *after* `arm()` could set a timer

Cosmetic: `arm()` is called after `chatAttempt`'s outer `try` block starts, but the timer fires only on the FIRST tick — if Mistral's first byte takes >`STREAM_IDLE_TIMEOUT_MS`, the timer fires during the read of the first chunk. With the current default (60 s) this is essentially never a problem; with `STREAM_IDLE_TIMEOUT_MS=500` in tests, it's a real concern that the test does cover (the `HANG` test fires the watchdog correctly).

### 24. `out.usage` can be `undefined`; the UI shows "no usage reported" but cost stays at 0

`server.ts:366` and `public/app.js:201–205`. This is correct — Mistral sends `usage` in the final SSE chunk, but if the chunk is lost (truncated, idle), we retry buffered, which DOES include usage. The only path where usage is genuinely missing is "reasoning-model-no-final-chunk" — keep an eye on this for cost drift. The cost counter explicitly documents this as an accepted estimate (AGENTS.md), so it's by design.

### 25. `LOG_ID` increments forever; fine for a long-running process

`server.ts:32`. Bun's `Number` is a double; `++seq` past 2⁵³ would lose precision (millions of years of uptime). Don't fix; just don't move it to a UUID.

---

## Edge cases not (yet) covered

### 26. Massive model output

If the model produces a 200k-token answer, `history` grows by that amount. The next turn's `chars` includes the full answer, hits `MAX_DOC_CHARS`, returns 413. So a runaway generation is *bounded* by the next-turn rejection, but the user has paid for the runaway generation. There's no per-message length cap on assistant output. Consider truncating assistant content server-side, or at least capping `addUsage`'s charge with a sanity bound on `usage.completion_tokens`.

### 27. Image content-type allowlist is loose

`okPart` requires `startsWith("data:image/")`. So `data:image/svg+xml;base64,<svg><script>...` is accepted. Mistral will receive it; whether the model treats SVG-with-script as text or executes is a Mistral-side concern. But on the *browser* side, `<img src="data:image/svg+xml;base64,...">` is sandboxed by `<img>` (no script execution), so no XSS. The thumbnail is shown in the chip — also via `<img>`. Safe. Worth a comment though, because the SVG-with-script case is the kind of thing future maintainers will worry about.

### 28. PDF parsing: scanned-PDF detection is "text layer is empty"

`extract.ts:30`. A password-protected PDF also has no text layer. `unpdf` would presumably throw before reaching the text-empty branch, but a corrupted-but-decryptable PDF with all empty pages would be rejected as "scanned PDF" — which is misleading. Consider a separate `pdf-encrypted` / `pdf-corrupt` message based on the unpdf error type.

### 29. `mammoth` warnings are swallowed with `console.warn`

`extract.ts:20`. The number of warnings is logged, not the content. If mammoth emits a security-relevant warning (e.g., about an embedded image referenced from the docx), it's hidden. Probably fine for V1; flag for V2 when reviewing the model output for prompt injection.

### 30. The `paste` handler on the document listens to `paste` even when the textarea is focused

`public/app.js:253` — `e.preventDefault()` is called only when there are image files. So pasting text into the textarea works, pasting a screenshot works. But what about pasting a *file path string* (e.g., from a file manager)? The text would land in the textarea — fine. Pasting an image while the focus is in the textarea would be intercepted; the user can't accidentally paste a screenshot into the text. Good. But the `if (busy) return` skips the `e.preventDefault()`, so a paste during a busy turn *would* insert the image bytes as text into the textarea. Cosmetic; document or add `e.preventDefault()` before the busy check.

---

## Tests — coverage gaps and "fake" tests

### 31. `server.test.ts` exercises a mock, not Mistral

This is acknowledged in the file header. The tests cover: streaming, idle watchdog, truncation, `[DONE]`-then-linger, API errors, HTML errors, slow requests, size limits, image validation, log redaction.

What's **not** covered:
- A real (or recorded) Mistral response shape, e.g., `choices[].delta.content` being an **array** of typed chunks. The mock returns plain strings. The `textOf` array-handling path is therefore not exercised.
- `prompt_tokens_details` missing → `cached_tokens` defaults to 0 in `addUsage`. Covered, but a future Mistral schema change (renaming `cached_tokens`) would silently zero out the savings. Add a defensive `expect(u.cachedTokens).toBeGreaterThan(0)` in the streaming-success test (already there implicitly via the calc).
- Multi-turn conversations (the browser's `history` array growing). The tests send a single user message; nothing checks that the second turn re-sends history correctly.
- The `/api/chat` cacheKey field *validation regex* edge cases: exactly 8 chars, exactly 64, with `_` or `+` (which should fail). The "junk rejected" test uses one bad string; add boundary cases.
- `okPart` for an `image_url` that's `data:image/jpeg` (no `;base64,`): the prefix check passes, but the URL is malformed for Mistral. Worth a 400.

### 32. `extract.test.ts` uses only synthetic 1-page PDFs (`makePdf`)

`test/fixtures.ts:5`. Real PDFs from Word/LaTeX/scanners are not covered. The `mammoth` docx fixtures are synthetic too. This is fine for the unit tests; the real risk is in pdf.js version drift (e.g., pdf.js changes how it parses a stream). A few small *real* PDFs (one with a font, one with an image, one with a multi-page table) committed under `test/fixtures-real/` would be cheap insurance.

### 33. `md.test.ts` covers the happy paths and a couple of XSS vectors, but not:
- Nested blockquotes (re-rendered by recursion; a deep one could blow the stack).
- Empty fenced code blocks.
- Mixed ordered/unordered list nesting.
- Tables without a separator row (currently treated as paragraphs — test that explicitly).
- Inline code containing `*` or `[` (currently the code span is extracted before inline formatting — test that backticks truly protect).
- Links with parens in the link text (`[a (b)](http://x.io)` — current regex requires `[^\s)]+` for the URL, so `[a (b)]` in text might parse but `http://x.io/foo(bar)` would fail). Worth testing.

### 34. `img.test.ts` covers `fitSize` only, not `shrinkImage`

`shrinkImage` requires `createImageBitmap` and a canvas — both unavailable in the test env (and per the AGENTS.md, **also unavailable in obscura**). The function is therefore tested only by manual runs in a real browser. If a future change to `shrinkImage` breaks silently, no test catches it. Consider:
- Extracting the JPEG-encode path into a pure helper that can run with a stubbed canvas (e.g., a fake `OffscreenCanvas` returning a stub `Blob`), **or**
- Adding a Playwright/real-browser smoke test that uploads a small PNG and asserts the chip appears with a data URL.

### 35. `money.test.ts` is solid; the only missing case is negative amounts (`-1`) and `NaN`/`Infinity`

`formatHuf(NaN)` returns `"NaN Ft"` — probably not a real input, but documenting it would prevent a future regression.

---

## Summary table

| # | Severity | File | One-liner |
|---|---|---|---|
| 1 | Critical | `server.ts:8–14` | NaN env vars disable guards |
| 2 | Critical | `server.ts`, `extract.ts` | Per-doc and per-conv limit are the same cap |
| 3 | Critical | `server.ts:344` | Deadline not reset on buffered retry |
| 4 | Critical | `server.ts:226` | SSE buffer is unbounded |
| 5 | Critical | `public/app.js:166` | `renderMarkdown` re-parses whole answer per delta (O(n²)) |
| 6 | Notable | `server.ts:155–165` | `idle` controller created in buffered mode and never used |
| 7 | Notable | `server.ts` | `any` types at the trust boundary |
| 8 | Notable | `server.ts:50` | `revealingHeaders` regex is over-broad |
| 9 | Notable | `test/server.test.ts:159` | `usage` test is order-coupled |
| 10 | Notable | `test/server.test.ts:48–58` | LINGER test relies on mock teardown |
| 11 | Notable | `server.ts:12` | 60 s idle default is too long for UX |
| 12 | Notable | `server.ts:275` | Hardcoded FX rate (ack'd `XXX`) |
| 13 | Minor | `extract.ts:33–43` | Dead CLI entrypoint |
| 14 | Minor | `server.ts:442` | `/api/usage` exposes cost to anyone on the box |
| 15 | Minor | `server.ts:139` | `imageBytes` is computed but unused |
| 16 | Minor | `server.ts:165` | Non-`Error` abort reasons — Bun-only |
| 17 | Minor | `server.ts:50` | Header regex doesn't filter cookies |
| 18 | Minor | `server.ts:130` | `okMsg` allows empty string content |
| 19 | Minor | `public/app.js:262` | Dragleave `relatedTarget` flicker |
| 20 | Minor | `public/app.js:228` | Textarea grow() reflows per keystroke |
| 21 | Minor | `public/style.css:91` | `color-mix` unsupported on old browsers |
| 22 | Minor | `misti.bat:36` | Browser-open polling cap is wall-time, not retries |
| 23 | Minor | `server.ts:163` | Watchdog arming order |
| 24 | Minor | `server.ts:366` | Cost drift when usage is missing |
| 25 | Minor | `server.ts:32` | seq as Number — fine, don't migrate |
| 26 | Edge | `server.ts` | No cap on assistant output length |
| 27 | Edge | `server.ts:127` | SVG data URLs accepted (safe but worth noting) |
| 28 | Edge | `extract.ts:30` | Encrypted / corrupted PDF confused with scanned |
| 29 | Edge | `extract.ts:20` | mammoth warnings swallowed |
| 30 | Edge | `public/app.js:253` | Paste during busy inserts bytes as text |
| 31 | Coverage | `test/server.test.ts` | No real-Mistral-shape coverage |
| 32 | Coverage | `test/extract.test.ts` | Only synthetic 1-page PDFs |
| 33 | Coverage | `test/md.test.ts` | No nested-blockquote stack test |
| 34 | Coverage | `test/img.test.ts` | `shrinkImage` never tested (canvas) |
| 35 | Coverage | `test/money.test.ts` | NaN/Infinity/negative not tested |

**Recommended order of fixes:** #1 (5 min, prevents money risk), #3 (5 min, prevents silent UX failure), #4 (10 min, prevents OOM), #2 (design decision), #5 (real perf once answers get long), then sweep #6–#12.

The codebase is in good shape. The architecture matches the stated ZDR/non-goals crisply; the biggest concrete risk is the `MAX_DOC_CHARS = NaN` foot-gun.