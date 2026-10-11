import { expect, test } from "bun:test";
const { fitSize, IMG_MAX_SIDE, IMG_MIN_SIDE } = require("../public/img.js");

test("large images shrink to the max side, aspect kept", () => {
  expect(fitSize(4000, 3000)).toEqual({ w: IMG_MAX_SIDE, h: Math.round((IMG_MAX_SIDE * 3) / 4) });
  expect(fitSize(1000, 5000)).toEqual({ w: Math.round(IMG_MAX_SIDE / 5), h: IMG_MAX_SIDE });
});

test("mid-size images are untouched", () => {
  expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
});

test("tiny images are upscaled (the model silently ignores them otherwise)", () => {
  expect(fitSize(16, 16)).toEqual({ w: IMG_MIN_SIDE, h: IMG_MIN_SIDE });
  expect(fitSize(64, 8)).toEqual({ w: IMG_MIN_SIDE, h: 16 });
});

test("extreme aspect never yields a zero side", () => {
  expect(fitSize(10000, 1).h).toBe(1);
});
