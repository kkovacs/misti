import { expect, test } from "bun:test";
const { formatHuf } = require("../public/money.js");

test("decimals shrink as amounts grow; Hungarian decimal comma", () => {
  expect(formatHuf(0)).toBe("0,00 Ft");
  expect(formatHuf(0.5312)).toBe("0,53 Ft");
  expect(formatHuf(9.996)).toBe("10,00 Ft"); // rounding happens after the threshold pick
  expect(formatHuf(12.34)).toBe("12,3 Ft");
  expect(formatHuf(1234.5)).toBe("1235 Ft");
});

test("large amounts use Hungarian digit grouping", () => {
  expect(formatHuf(12345)).toMatch(/^12\s345 Ft$/); // NBSP group separator
});
