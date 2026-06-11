import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRatio } from "../crop.js";

describe("parseRatio", () => {
  it("parses common separators", () => {
    assert.deepEqual(parseRatio("5:4"), [5, 4]);
    assert.deepEqual(parseRatio("5/4"), [5, 4]);
    assert.deepEqual(parseRatio("5x4"), [5, 4]);
    assert.deepEqual(parseRatio("5,4"), [5, 4]);
    assert.deepEqual(parseRatio("5 4"), [5, 4]);
    assert.deepEqual(parseRatio("  16 : 9 "), [16, 9]);
  });

  it("parses decimals", () => {
    assert.deepEqual(parseRatio("1.85:1"), [1.85, 1]);
    assert.deepEqual(parseRatio("2.39:1"), [2.39, 1]);
  });

  it("rejects malformed input", () => {
    assert.equal(parseRatio(""), null);
    assert.equal(parseRatio("5"), null);
    assert.equal(parseRatio("5:"), null);
    assert.equal(parseRatio(":4"), null);
    assert.equal(parseRatio("a:b"), null);
    assert.equal(parseRatio("5:4:3"), null);
    assert.equal(parseRatio("-5:4"), null);
  });

  it("rejects zero sides", () => {
    assert.equal(parseRatio("0:4"), null);
    assert.equal(parseRatio("5:0"), null);
  });
});
