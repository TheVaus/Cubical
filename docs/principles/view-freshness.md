# view-freshness — A cached view must refresh when the engine changes what it mirrors

**Rule:** Refresh a cached view whenever the state behind it changes, no matter who changed it.

**Gate:** `scripts/gates/view_freshness.py` — renames go through one chokepoint; every cache-bearing resolver is registered for refresh. Landed at 0 violations, as a ratchet.

**Why:** The frontend caches two things the engine owns: the text of the open note, and per-vault resolver caches for links, embeds, property refs and dataview results. Both went stale in ways no test could see, because the code stayed correct while the wiring stopped covering a case. A rename rekeys the index immediately but defers the referrer text to the pending-rewrites flush, so an open buffer keeps the old link text while resolution has already moved on — the link renders broken with the corrected text sitting one `read_file_text` away. And an edit you make in the app is an own-write echo, so gating cache invalidation on "was this someone else's write?" means your own edits never refresh anything: the caches are keyed per vault, not per document, so every *other* note serves pre-edit values for the rest of the session. Who wrote the bytes is never the question. Whether they changed is.

**Exceptions:** A buffer with unsaved edits is never overwritten by a refresh — the user's work wins, and the queued rewrite still reaches disk at the flush. Refreshes prefer stale-while-revalidate over clearing: clearing a cache on every autosave flashes each widget through its loading state, so a cached value keeps rendering while one background refetch replaces it.

**Detail:** [`../architecture/document-model.md`](../architecture/document-model.md) §5.7 owns the deferred-write model · [`convergence-over-interception.md`](convergence-over-interception.md) for the filesystem half of the same problem.
