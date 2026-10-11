import { describe, expect, test } from "bun:test";
import { extractText } from "../extract.ts";
import { makeDocx, makePdf } from "./fixtures.ts";

describe("extractText", () => {
  test("pdf with text layer", async () => {
    const r = await extractText(makePdf(["Project Zephyr", "budget 4242 EUR"]), "a.PDF");
    expect(r).toMatchObject({ ok: true, kind: "pdf", pages: 1 });
    if (r.ok) expect(r.text).toContain("budget 4242 EUR");
  });

  test("pdf without text layer -> scanned error", async () => {
    const r = await extractText(makePdf([]), "scan.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("scanned");
  });

  test("docx", async () => {
    const r = await extractText(await makeDocx(["Első bekezdés", "Második"]), "w.docx");
    expect(r).toMatchObject({ ok: true, kind: "docx" });
    if (r.ok) expect(r.text).toContain("Első bekezdés");
  });

  test("corrupt docx fails fast (throws)", async () => {
    await expect(extractText(new TextEncoder().encode("not a zip").buffer as ArrayBuffer, "x.docx")).rejects.toThrow();
  });

  test("unsupported extension", async () => {
    const r = await extractText(new ArrayBuffer(1), "notes.txt");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("unsupported file type") });
  });
});
