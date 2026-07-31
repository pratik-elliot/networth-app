// Blob URLs created from attachment bytes are memoised here, at module
// scope, rather than inside the <Attachment> component. Two problems this
// solves at once:
//
//   1. Leak: a bare component used to call the fetch-and-createObjectURL
//      path on every click (documents) or every mount (images) and never
//      revoke the result -- N clicks/mounts retained N full copies of the
//      file for the rest of the page's life. With a shared cache keyed by
//      attachment id, repeat lookups reuse the same URL instead of minting
//      a new one, so there is nothing left to leak until the attachment is
//      actually removed (releaseBlobUrl, called from the delete flow).
//
//   2. Refetch: switching between accounts and back previously re-downloaded
//      full bytes for attachments already seen this session, on top of
//      competing with everything else for the shared /api rate limit.
//      Caching across mounts means a given attachment's bytes are fetched
//      at most once per page load.
//
// Deliberately NOT revoked on component unmount: the whole point of the
// cache is that a later remount reuses the same URL, and revoking it at
// unmount would leave that later remount holding a dead blob: URL.

const cache = new Map(); // id -> { url: string|null, promise: Promise<string> }

/**
 * Returns the cached blob URL for `id`, fetching it via `fetcher(id)` at
 * most once. Concurrent callers before the first fetch resolves share the
 * same in-flight promise rather than triggering a second network request.
 */
function getOrFetchBlobUrl(id, fetcher) {
  const existing = cache.get(id);
  if (existing) return existing.promise;

  const promise = Promise.resolve(fetcher(id)).then((url) => {
    const entry = cache.get(id);
    if (entry) entry.url = url;
    return url;
  }).catch((err) => {
    // A failed fetch must not poison the cache forever -- the next
    // click/mount should be allowed to retry.
    cache.delete(id);
    throw err;
  });

  cache.set(id, { url: null, promise });
  return promise;
}

/** Synchronous read of whatever is already cached, or null if nothing is. */
function peekBlobUrl(id) {
  return cache.get(id)?.url || null;
}

/**
 * Revokes and forgets the cached URL for `id`. Call this when the
 * attachment itself is deleted -- not on every component unmount, which
 * would defeat the cache above.
 */
function releaseBlobUrl(id) {
  const entry = cache.get(id);
  if (!entry) return;
  cache.delete(id);
  if (entry.url) {
    URL.revokeObjectURL(entry.url);
  } else {
    // A fetch was still in flight when the attachment was removed -- revoke
    // once it lands instead of leaking it.
    entry.promise.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
}

/** Test-only: drops all entries without revoking, so tests don't leak into each other. */
function _clearForTests() {
  cache.clear();
}

export { getOrFetchBlobUrl, peekBlobUrl, releaseBlobUrl, _clearForTests };
