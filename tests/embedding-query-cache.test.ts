import { describe, it, expect } from "bun:test";
import { embeddingCacheKey, EmbeddingCache } from "../src/services/embedding.js";

// Pins the query-embedding cache. MEASURED 2026-09-03 against the live vessel, at host
// load ~5.5, with controls that isolate the cost to one call:
//
//     GET /concepts/<id>                       0.035s
//     GET /concepts/search?source_type=…       0.154s   <- filter-only: NO query embedding
//     GET /concepts/search?query=…             8–11.6s  <- the entire cost is the embedding
//
// The DB, the HNSW index and routing are all fast. `embeddingService.embed(query)`
// (concept.ts:661) runs a local ONNX inference padded to MAX_SEQ_LEN on EVERY call, and
// the identical query recomputes from scratch every time — measured 8.5s / 11.6s / 8.4s
// for three consecutive runs of the same string.
//
// WHY IT MATTERS BEYOND LATENCY. feature-compose consults these principles before
// planning ("CONSULTATION-ON-AUTHOR") on an 8s budget. At ~10s that consult times out, so
// the drafter plans with NO architectural principles — development-vessel logged 18
// principle-consult failures in one afternoon while concept-db /health answered in 6.7ms.
// That is why the substrate invented `exports.substrateGap.emit` and then
// `/v2/impulses/substrateGap`: the contract WAS in the store and the reader could not
// afford to read it. A health check that measures the wrong thing reported green throughout.
//
// The consult reduces a spec to a few salient terms (feature-compose's principleTerms),
// so queries repeat heavily across composes — exactly the workload a cache serves.

describe("embeddingCacheKey", () => {
  it("is stable for identical text", () => {
    expect(embeddingCacheKey("resolver contract")).toBe(embeddingCacheKey("resolver contract"));
  });

  it("distinguishes different text", () => {
    expect(embeddingCacheKey("resolver contract")).not.toBe(embeddingCacheKey("impulse emission"));
  });

  it("does not collide on whitespace-only differences being treated as identical", () => {
    // Deliberately NOT normalised: the embedder is sensitive to spacing, so two strings
    // that differ at all must get different vectors rather than a silently shared one.
    expect(embeddingCacheKey("a b")).not.toBe(embeddingCacheKey("a  b"));
  });
});

describe("EmbeddingCache", () => {
  it("returns the stored vector on a hit and undefined on a miss", () => {
    const c = new EmbeddingCache(4);
    const v = new Float32Array([1, 2, 3]);
    expect(c.get("x")).toBeUndefined();
    c.set("x", v);
    expect(c.get("x")).toBe(v);
  });

  it("is BOUNDED — evicts least-recently-used, so it cannot grow without limit", () => {
    const c = new EmbeddingCache(2);
    c.set("a", new Float32Array([1]));
    c.set("b", new Float32Array([2]));
    c.get("a");                          // 'a' becomes most-recent, 'b' is now LRU
    c.set("c", new Float32Array([3]));   // evicts 'b'
    expect(c.get("a")).toBeDefined();
    expect(c.get("c")).toBeDefined();
    expect(c.get("b")).toBeUndefined();
    expect(c.size).toBe(2);
  });

  it("refreshes recency on set of an existing key", () => {
    const c = new EmbeddingCache(2);
    c.set("a", new Float32Array([1]));
    c.set("b", new Float32Array([2]));
    c.set("a", new Float32Array([9]));   // 'a' most-recent again
    c.set("c", new Float32Array([3]));   // evicts 'b'
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")?.[0]).toBe(9);
  });

  it("a zero/negative capacity disables caching rather than throwing", () => {
    const c = new EmbeddingCache(0);
    c.set("a", new Float32Array([1]));
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(0);
  });
});
