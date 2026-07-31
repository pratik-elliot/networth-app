const test = require("node:test");
const assert = require("node:assert");
const { collections } = require("../src/db");

test("collections() refuses to hand out handles before connect()", () => {
  assert.throws(() => collections(), /not connected/i);
});
