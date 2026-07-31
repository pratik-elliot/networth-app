const test = require("node:test");
const assert = require("node:assert");

function loadFresh() {
  delete require.cache[require.resolve("../src/services/statementExtract")];
  return require("../src/services/statementExtract");
}

function stubFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  fn.calls = calls;
  return fn;
}

const modelSaid = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

test.afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
});

test("isConfigured reflects the API key", () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.strictEqual(loadFresh().isConfigured(), false);
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.strictEqual(loadFresh().isConfigured(), true);
});

test("extractTransactions always enforces zero data retention", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("statement text", { fetchImpl });

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepStrictEqual(body.provider, { zdr: true, data_collection: "deny" },
    "statement text must never be sent to a provider that may retain it");
});

test("extractTransactions defaults to the free Ling model", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(JSON.parse(fetchImpl.calls[0].init.body).model, "inclusionai/ling-3.0-flash:free");
});

test("extractTransactions honours OPENROUTER_MODEL", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "some/other-model";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(JSON.parse(fetchImpl.calls[0].init.body).model, "some/other-model");
});

test("extractTransactions sends the API key as a bearer token", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(fetchImpl.calls[0].init.headers.Authorization, "Bearer test-key");
});

test("extractTransactions returns the rows the model reported", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const rows = [{ date: "2026-02-13", description: "Salary", type: "credit", amount: "50000" }];
  const fetchImpl = stubFetch(modelSaid({ transactions: rows }));
  assert.deepStrictEqual(await loadFresh().extractTransactions("text", { fetchImpl }), rows);
});

test("extractTransactions returns an empty array when the model finds nothing", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  assert.deepStrictEqual(await loadFresh().extractTransactions("text", { fetchImpl }), []);
});

test("extractTransactions explains a missing ZDR provider", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ error: { message: "No endpoints found matching your data policy" } }, { status: 404 });
  await assert.rejects(
    () => loadFresh().extractTransactions("text", { fetchImpl }),
    /zero.data.retention|data policy/i
  );
});

test("extractTransactions reports rate limiting plainly", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ error: { message: "rate limited" } }, { status: 429 });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /too many|limit/i);
});

test("extractTransactions reports a rejected key", async () => {
  process.env.OPENROUTER_API_KEY = "bad-key";
  const fetchImpl = stubFetch({ error: { message: "invalid" } }, { status: 401 });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /API key/i);
});

test("extractTransactions rejects unparseable model output", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ choices: [{ message: { content: "I am not JSON" } }] });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /could not read/i);
});

test("extractTransactions tolerates a model that wraps JSON in code fences", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fenced = "```json\n{\"transactions\":[{\"date\":\"2026-02-13\",\"amount\":\"5\"}]}\n```";
  const fetchImpl = stubFetch({ choices: [{ message: { content: fenced } }] });
  const out = await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(out.length, 1);
});

test("extractTransactions does not send response_format", async () => {
  // The default model rejects structured outputs outright with a 400, so
  // requiring the feature would break every import.
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.strictEqual(body.response_format, undefined);
});

test("extractTransactions surfaces the provider's own error message", async () => {
  // A bare "returned 400" sends the reader hunting for a diagnostic that was
  // in the response body all along.
  process.env.OPENROUTER_API_KEY = "test-key";
  const upstream = {
    error: {
      message: "Provider returned error",
      code: 400,
      metadata: {
        raw: JSON.stringify({ code: 400, message: "model: some/model does not support feature: structured-outputs" }),
        provider_name: "Novita",
      },
    },
  };
  const fetchImpl = stubFetch(upstream, { status: 400 });
  await assert.rejects(
    () => loadFresh().extractTransactions("text", { fetchImpl }),
    /does not support feature: structured-outputs/
  );
});

test("extractTransactions falls back to the outer message when there is no nested raw", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ error: { message: "context length exceeded" } }, { status: 400 });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /context length exceeded/);
});

test("extractTransactions refuses to run without an API key", async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(() => loadFresh().extractTransactions("text", {}), /not configured/i);
});
