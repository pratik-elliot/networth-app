import test from "node:test";
import assert from "node:assert";
import { handle } from "../src/api.js";

/* A minimal stand-in for the fetch Response object handle() consumes -- only
   the bits it actually reads: .ok, .status, and .json(). */
function fakeResponse({ ok, status, body }) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test("handle() lifts a coded error response into an Error with .code and .status", async () => {
  const res = fakeResponse({ ok: false, status: 400, body: { error: "This PDF is encrypted.", code: "PASSWORD_REQUIRED" } });
  await assert.rejects(
    () => handle(res),
    (err) => {
      assert.strictEqual(err.message, "This PDF is encrypted.");
      assert.strictEqual(err.code, "PASSWORD_REQUIRED");
      assert.strictEqual(err.status, 400);
      return true;
    }
  );
});

test("handle() leaves .code undefined when the error response carries none", async () => {
  await assert.rejects(
    () => handle(fakeResponse({ ok: false, status: 500, body: { error: "Something broke." } })),
    (err) => {
      assert.strictEqual(err.message, "Something broke.");
      assert.strictEqual(err.code, undefined);
      assert.strictEqual(err.status, 500);
      return true;
    }
  );
});

test("handle() returns the parsed JSON body on a successful response", async () => {
  const body = { rows: [{ date: "2026-02-13", amount: 5 }] };
  const res = fakeResponse({ ok: true, status: 200, body });
  const out = await handle(res);
  assert.deepStrictEqual(out, body);
});
