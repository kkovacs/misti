// extract.ts — pull plain text out of docx/pdf bytes, fully local.
// This is the ZDR-safe half of the pipeline: no network, no stateful API, no disk writes.
// docx → mammoth (parses the zip's XML); pdf → unpdf (pdf.js text layer).
import mammoth from "mammoth";
import { extractText as pdfExtractText, getDocumentProxy } from "unpdf";

export type ExtractResult =
  | { ok: true; kind: "docx" | "pdf"; text: string; pages?: number }
  | { ok: false; error: string };

// Dispatch on filename extension; the bytes come from an upload or the CLI.
export async function extractText(data: ArrayBuffer, filename: string): Promise<ExtractResult> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) return extractDocx(data);
  if (lower.endsWith(".pdf")) return extractPdf(data);
  return { ok: false, error: `unsupported file type (want .docx or .pdf): ${filename}` };
}

async function extractDocx(data: ArrayBuffer): Promise<ExtractResult> {
  const { value, messages } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  if (messages.length) console.warn(`[extract] mammoth warnings: ${messages.length} (ignored)`);
  return { ok: true, kind: "docx", text: value };
}

async function extractPdf(data: ArrayBuffer): Promise<ExtractResult> {
  // verbosity 0 = errors only: silences pdf.js "TT: undefined function" font noise.
  const doc = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  const { totalPages, text } = await pdfExtractText(doc);
  const joined = text.join("\n").trim();
  // A scan has no embedded text layer — fail loudly, never send an empty doc to the model.
  if (!joined) return { ok: false, error: "no text layer detected (scanned PDF) — not supported in V1" };
  return { ok: true, kind: "pdf", text: joined, pages: totalPages };
}

// CLI: bun extract.ts <file>  (spike test without the server)
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun extract.ts <file.docx|file.pdf>");
    process.exit(1);
  }
  const res = await extractText(await Bun.file(path).arrayBuffer(), path);
  if (!res.ok) {
    console.error("[extract] FAILED:", res.error);
    process.exit(1);
  }
  console.log(`[extract] OK ${res.kind}${res.pages ? ` ${res.pages} pages` : ""} — ${res.text.length} chars`);
  console.log("--- preview (first 600 chars) ---");
  console.log(res.text.slice(0, 600));
}
