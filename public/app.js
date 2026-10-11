// app.js — MISTI browser client (vanilla JS).
// All conversation state lives here; the server is a stateless proxy. Reload = fresh chat.
const $ = (sel) => document.querySelector(sel);
const history = []; // [{role, content}] exactly as sent to /api/chat
let pending = []; // extracted docs waiting to be attached to the next question
let busy = null; // AbortController of the in-flight chat
let chatGen = 0; // bumped by "New chat"; stale turns must not touch the new chat

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const log = $("#log");
const hint = $(".hint");
const add = (node) => {
  log.append(node);
  log.scrollTop = log.scrollHeight;
  return node;
};
const note = (text, cls = "system") => add(el("div", `msg ${cls}`, text));
const usd = (n) => `$${n.toFixed(4)}`;

// --- documents -----------------------------------------------------------------------------

function renderPending() {
  const box = $("#docs");
  box.replaceChildren(
    ...pending.map((d, i) => {
      const chip = el("span", "chip", `${d.name} (${d.chars.toLocaleString()} chars${d.pages ? `, ${d.pages} p` : ""})`);
      const x = el("button", null, "x");
      x.type = "button";
      x.title = "Remove";
      x.onclick = () => {
        pending.splice(i, 1);
        renderPending();
      };
      chip.append(x);
      return chip;
    }),
  );
}

async function upload(files) {
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    const status = note(`Extracting ${file.name}...`);
    try {
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      pending.push(data);
      status.textContent = `Extracted ${file.name}: ${data.chars.toLocaleString()} chars. It will be attached to your next question.`;
      renderPending();
    } catch (err) {
      status.className = "msg error";
      status.textContent = `${file.name}: ${err.message}`;
    }
  }
}

// Docs go into the user turn once; later turns resend them as part of history (cache-friendly prefix).
const docBlock = (d) => `<document name="${d.name.replace(/"/g, "'")}">\n${d.text}\n</document>\n\n`;

// --- chat ----------------------------------------------------------------------------------

function userBubble(question, docs) {
  const b = el("div", "msg user");
  if (docs.length) {
    const chips = el("div", "chips");
    for (const d of docs) chips.append(el("span", "chip", d.name));
    b.append(chips);
  }
  b.append(el("div", "text", question));
  return add(b);
}

function assistantBubble() {
  const b = el("div", "msg assistant");
  const text = b.appendChild(el("div", "md"));
  const meta = b.appendChild(el("div", "meta"));
  add(b);
  return { b, text, meta };
}

async function send(question) {
  const docs = pending;
  const content = docs.map(docBlock).join("") + question;
  history.push({ role: "user", content });
  pending = [];
  renderPending();
  userBubble(question, docs);
  const ui = assistantBubble();
  ui.meta.textContent = "thinking...";

  const gen = chatGen;
  busy = new AbortController();
  setBusy(true);
  let answer = "";
  let done = null;
  let error = null;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, stream: $("#stream").checked }),
      signal: busy.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      throw new Error(data.message);
    }
    // NDJSON events: delta / reset (streaming failed, buffered retry follows) / done / error.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const ev = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (ev.type === "delta") {
          answer += ev.text;
          ui.text.innerHTML = renderMarkdown(answer); // md.js escapes everything
          ui.meta.textContent = "";
          log.scrollTop = log.scrollHeight;
        } else if (ev.type === "reset") {
          answer = "";
          ui.text.replaceChildren();
          ui.meta.textContent = `stream failed (${ev.reason}) — retrying without streaming...`;
        } else if (ev.type === "done") done = ev;
        else if (ev.type === "error") error = ev;
      }
    }
    if (error) throw new Error(error.message);
    if (!done) throw new Error("connection to local server ended unexpectedly");
  } catch (err) {
    if (gen !== chatGen) return; // aborted by "New chat": nothing to roll back into
    // Roll back the turn so the user can simply retry (question + docs restored).
    history.pop();
    ui.b.classList.add("error");
    ui.text.innerHTML = renderMarkdown(answer);
    ui.meta.replaceChildren(el("span", "error", err.name === "AbortError" ? "stopped" : err.message));
    pending = docs.concat(pending);
    renderPending();
    if (!$("#input").value) $("#input").value = question;
    return;
  } finally {
    busy = null;
    setBusy(false);
  }

  history.push({ role: "assistant", content: answer });
  const copy = el("button", null, "Copy");
  copy.type = "button";
  copy.onclick = async () => {
    await navigator.clipboard.writeText(answer); // raw markdown
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  };
  const u = done.usage;
  const info = u
    ? `${u.prompt_tokens.toLocaleString()} in (${(u.prompt_tokens_details?.cached_tokens ?? 0).toLocaleString()} cached) / ${u.completion_tokens.toLocaleString()} out · ${usd(done.costUsd)}`
    : "no usage reported";
  ui.meta.replaceChildren(copy, el("span", null, info + (done.finishReason && done.finishReason !== "stop" ? ` · finish: ${done.finishReason}` : "")));
  $("#cost").textContent = usd(done.totalUsd);
}

function setBusy(on) {
  $("#send").textContent = on ? "Stop" : "Send";
  $("#attach").disabled = on;
}

// --- wiring --------------------------------------------------------------------------------

$("#form").onsubmit = (e) => {
  e.preventDefault();
  if (busy) return busy.abort();
  const q = $("#input").value.trim();
  if (!q) return;
  $("#input").value = "";
  send(q);
};
$("#input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) $("#form").requestSubmit();
  }
};
$("#attach").onclick = () => $("#file").click();

// New chat: stop any answer in flight, drop history, pending docs and the visible log.
// The server keeps nothing, so this is a full reset (cost counter is server-side, stays).
$("#new").onclick = () => {
  chatGen++;
  busy?.abort();
  history.length = 0;
  pending = [];
  renderPending();
  log.replaceChildren(hint);
  $("#input").value = "";
  $("#input").focus();
};
$("#file").onchange = (e) => {
  upload([...e.target.files]);
  e.target.value = "";
};

// Drag & drop anywhere on the page.
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (!busy) upload([...e.dataTransfer.files]);
});

$("#health").onclick = async () => {
  const s = $("#health-status");
  s.className = "";
  s.textContent = "checking...";
  try {
    const h = await (await fetch("/api/health")).json();
    s.className = h.ok && h.modelAvailable ? "ok" : "bad";
    s.textContent = h.ok
      ? `OK ${h.ms} ms${h.modelAvailable ? "" : ` — model ${h.model} NOT available`}`
      : `${h.kind}: ${h.message}`;
  } catch (err) {
    s.className = "bad";
    s.textContent = `local server unreachable: ${err.message}`;
  }
};

// Cost counter survives a page reload (server-side, in-memory).
fetch("/api/usage")
  .then((r) => r.json())
  .then((u) => ($("#cost").textContent = usd(u.usd)));
