import test from "node:test";
import assert from "node:assert";
import { getOrFetchBlobUrl, peekBlobUrl, releaseBlobUrl, _clearForTests } from "../src/lib/attachmentBlobCache.js";

function makeFetcher() {
  const calls = [];
  return {
    calls,
    fetcher: async (id) => {
      calls.push(id);
      return `blob:fake-${id}-${calls.length}`;
    },
  };
}

test("getOrFetchBlobUrl fetches once per id and memoises the result across repeated calls", async () => {
  _clearForTests();
  const { fetcher, calls } = makeFetcher();

  const first = await getOrFetchBlobUrl("att-1", fetcher);
  const second = await getOrFetchBlobUrl("att-1", fetcher);

  assert.strictEqual(first, second);
  // This is the fix for finding #4 -- a remounted <Attachment> (or a second
  // click on the same document) must not re-download the full bytes.
  assert.strictEqual(calls.length, 1, "a second call for the same id must not refetch");
  assert.strictEqual(peekBlobUrl("att-1"), first);
});

test("concurrent calls before the first fetch resolves share one in-flight request", async () => {
  _clearForTests();
  let resolveFetch;
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };

  const p1 = getOrFetchBlobUrl("att-2", fetcher);
  const p2 = getOrFetchBlobUrl("att-2", fetcher);
  resolveFetch("blob:fake-att-2");
  const [a, b] = await Promise.all([p1, p2]);

  assert.strictEqual(a, "blob:fake-att-2");
  assert.strictEqual(b, "blob:fake-att-2");
  assert.strictEqual(calls, 1, "two callers racing before resolution must share one fetch, not start a second");
});

test("releaseBlobUrl revokes the cached URL and forgets it, so a later get refetches", async (t) => {
  _clearForTests();
  const { fetcher, calls } = makeFetcher();
  const revoked = [];
  t.mock.method(URL, "revokeObjectURL", (url) => { revoked.push(url); });

  const url = await getOrFetchBlobUrl("att-3", fetcher);
  releaseBlobUrl("att-3");

  // This is the fix for finding #3 -- the leak was that nothing ever called
  // revokeObjectURL for a document's blob URL. Deletion is where release
  // must happen.
  assert.deepStrictEqual(revoked, [url], "releasing an attachment must revoke exactly its own cached blob URL");
  assert.strictEqual(peekBlobUrl("att-3"), null);

  await getOrFetchBlobUrl("att-3", fetcher);
  assert.strictEqual(calls.length, 2, "a released attachment must be refetched, not served from a revoked cache entry");
});

test("releaseBlobUrl called while a fetch is still in flight revokes once it lands, rather than leaking it", async (t) => {
  _clearForTests();
  const revoked = [];
  t.mock.method(URL, "revokeObjectURL", (url) => { revoked.push(url); });
  let resolveFetch;
  const fetcher = () => new Promise((resolve) => { resolveFetch = resolve; });

  const pending = getOrFetchBlobUrl("att-4", fetcher);
  releaseBlobUrl("att-4"); // deleted before the fetch even resolves
  resolveFetch("blob:fake-att-4");
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the .then() chain settle

  assert.deepStrictEqual(revoked, ["blob:fake-att-4"]);
});

test("a failed fetch does not poison the cache -- a later call retries instead of replaying the rejection", async () => {
  _clearForTests();
  let attempt = 0;
  const fetcher = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network error");
    return "blob:fake-att-5-retry";
  };

  await assert.rejects(() => getOrFetchBlobUrl("att-5", fetcher));
  const url = await getOrFetchBlobUrl("att-5", fetcher);
  assert.strictEqual(url, "blob:fake-att-5-retry");
  assert.strictEqual(attempt, 2);
});
