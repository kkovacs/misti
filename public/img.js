// img.js — prepare images for the model, in the browser (no server round-trip, no dependency).
// Images ride inline in every turn (data: URL), so they are shrunk to bound cost and request size.

const IMG_MAX_SIDE = 1536; // plenty for screenshots/photos; larger only costs tokens
// XXX empirical: mistral-large-4 silently ignored a 16x16 image but read 128x128. Upscale tiny ones.
const IMG_MIN_SIDE = 128;

// Target size: longest side clamped into [IMG_MIN_SIDE, IMG_MAX_SIDE], aspect kept.
function fitSize(w, h) {
  const long = Math.max(w, h);
  const scale = long > IMG_MAX_SIDE ? IMG_MAX_SIDE / long : long < IMG_MIN_SIDE ? IMG_MIN_SIDE / long : 1;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

// File -> { url: JPEG data URL, w, h }. JPEG has no alpha, so paint white first (transparent PNGs).
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  if (!bmp.width || !bmp.height) throw new Error("browser could not decode the image");
  const { w, h } = fitSize(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = w < bmp.width; // smooth when shrinking, crisp pixels when upscaling
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const url = canvas.toDataURL("image/jpeg", 0.85);
  if (!url.startsWith("data:image/")) throw new Error("browser could not encode the image"); // e.g. "data:," on failure
  return { url, w, h };
}

// Browser: globals. Bun tests: CommonJS export.
if (typeof module !== "undefined") module.exports = { fitSize, IMG_MAX_SIDE, IMG_MIN_SIDE };
