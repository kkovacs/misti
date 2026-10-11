// probe.ts — de-risk the Mistral EU endpoint for a ZDR-compliant doc UI.
// Verifies: (1) /v1/ocr accepts a PDF inline as a base64 data: URI (V2 OCR path),
//           (2) the EU endpoint + chosen model are reachable,
//           (3) chat streaming works (the UI will stream).
// All calls hit stateless, ZDR-scoped endpoints only — never /v1/files, agents, batch.
//
// Usage: MISTRAL_API_KEY=... bun probe.ts
// Env:   MISTRAL_BASE_URL  (default https://api.eu.mistral.ai)
//        MISTRAL_MODEL      (default mistral-large-4)
//        MISTRAL_OCR_MODEL  (default mistral-ocr-latest)

const BASE = process.env.MISTRAL_BASE_URL ?? "https://api.eu.mistral.ai";
const KEY = process.env.MISTRAL_API_KEY;
const CHAT_MODEL = process.env.MISTRAL_MODEL ?? "mistral-large-4";
const OCR_MODEL = process.env.MISTRAL_OCR_MODEL ?? "mistral-ocr-latest";

if (!KEY) {
  console.error("MISTRAL_API_KEY is not set. Export it and re-run.");
  process.exit(1);
}

// Minimal valid single-page PDF with visible text ("HELLO ZDR").
// Hand-built with correct xref offsets so no dependency is needed for a test file.
function makeTestPdf(): string {
  const content = "BT /F1 24 Tf 72 720 Td (HELLO ZDR) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${off.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return pdf;
}

// Test 1: OCR on a base64 PDF. There is no document_base64 type; the data: URI goes into
// document_url (verified). Never use `file`/file_id — that needs stateful /v1/files.
async function testOcr(): Promise<string | null> {
  const pdf = makeTestPdf();
  const b64 = Buffer.from(pdf).toString("base64");
  console.log(`[ocr] POST ${BASE}/v1/ocr  model=${OCR_MODEL}  pdf=${pdf.length} bytes`);

  const res = await fetch(`${BASE}/v1/ocr`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OCR_MODEL,
      document: { type: "document_url", document_url: `data:application/pdf;base64,${b64}`, document_name: "probe.pdf" },
      include_image_base64: false, // text only; images would bloat the chat context
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[ocr] FAILED ${res.status}: ${text}`);
    return null;
  }
  const data = JSON.parse(text);
  const markdown = (data.pages ?? []).map((p: any) => p.markdown).join("\n");
  console.log(`[ocr] OK — markdown:\n---\n${markdown}\n---`);
  return markdown;
}

// Test 2: streaming chat completion, echoing OCR output back to prove the full loop.
async function testChat(contextText: string): Promise<void> {
  console.log(`[chat] POST ${BASE}/v1/chat/completions  model=${CHAT_MODEL}  stream=true`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      stream: true,
      messages: [{ role: "user", content: `Summarize this text in one short line:\n\n${contextText}` }],
    }),
  });

  if (!res.ok || !res.body) {
    console.error(`[chat] FAILED ${res.status}: ${await res.text()}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  process.stdout.write("[chat] streaming: ");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
        if (delta) process.stdout.write(delta);
      } catch {
        /* ignore keep-alive / partial frames */
      }
    }
  }
  process.stdout.write("\n[chat] OK — stream complete.\n");
}

async function main() {
  console.log(`Probe against ${BASE} (stateless, ZDR-scoped endpoints only)`);
  console.log(`Note: confirm ${CHAT_MODEL} / ${OCR_MODEL} are ZDR-enabled on your EU plan.\n`);

  const ocrText = await testOcr();
  // Chat is de-risked independently even if OCR fails, so always run it.
  await testChat(ocrText ?? "The quick brown fox jumps over the lazy dog.");
  console.log("\nProbe complete.");
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
