import { test } from "node:test";
import assert from "node:assert";
import {
  requestedRange,
  coveredBy,
  dedupeDecision,
  WHOLE_READ_CAP,
} from "../src/dedupe.js";

// --- requestedRange: map a Read(offset, limit) to 1-based inclusive lines ----

test("requestedRange: a whole-file read spans the whole file", () => {
  assert.deepEqual(requestedRange(undefined, undefined, 50), [1, 50]);
});

test("requestedRange: offset + limit is a bounded span", () => {
  assert.deepEqual(requestedRange(10, 20, 50), [10, 29]);
});

test("requestedRange: offset without limit runs to end of file", () => {
  assert.deepEqual(requestedRange(10, undefined, 50), [10, 50]);
});

test("requestedRange: a whole read of a huge file caps at the Read line cap", () => {
  assert.deepEqual(requestedRange(undefined, undefined, 5000), [1, WHOLE_READ_CAP]);
});

// --- coveredBy: is a range fully inside the union of prior ranges? -----------

test("coveredBy: a sub-range of one prior range is covered", () => {
  assert.equal(coveredBy([10, 20], [[1, 50]]), true);
});

test("coveredBy: a range extending past the prior range is NOT covered", () => {
  assert.equal(coveredBy([10, 60], [[1, 50]]), false);
});

test("coveredBy: two adjacent prior ranges together cover the request", () => {
  assert.equal(coveredBy([10, 20], [[1, 15], [16, 30]]), true);
});

test("coveredBy: a gap between prior ranges leaves the request uncovered", () => {
  assert.equal(coveredBy([10, 20], [[1, 9], [21, 30]]), false);
});

// --- dedupeDecision: the redesigned, offset-agnostic identity check ----------

test("dedupeDecision: an offset re-read of an already-read whole file is a duplicate", () => {
  // THE MISMATCH FIX: the old rule exempted any offset/limit read. Identity is
  // path+content, so re-reading lines already delivered is a duplicate.
  const priorReads = [{ hash: "h1", start: 1, end: 50, at: 100 }];
  const d = dedupeDecision({
    priorReads,
    requested: [10, 20],
    currentHash: "h1",
  });
  assert.equal(d.deny, true);
});

test("dedupeDecision: a genuinely new region of a partially-read file is allowed", () => {
  // CONSTRAINT 1: never deny a region the agent has not seen yet.
  const priorReads = [{ hash: "h1", start: 1, end: 50, at: 100 }];
  const d = dedupeDecision({
    priorReads,
    requested: [40, 120],
    currentHash: "h1",
  });
  assert.equal(d.deny, false);
});

test("dedupeDecision: a changed file (different hash) is always allowed", () => {
  const priorReads = [{ hash: "old", start: 1, end: 50, at: 100 }];
  const d = dedupeDecision({
    priorReads,
    requested: [1, 50],
    currentHash: "new",
  });
  assert.equal(d.deny, false);
});

test("dedupeDecision: a read recorded before the last compaction is allowed", () => {
  // CORRECTNESS: compaction may have summarized the earlier read away, so its
  // content is no longer in context. Denying it would deny real information.
  const priorReads = [{ hash: "h1", start: 1, end: 50, at: 100 }];
  const d = dedupeDecision({
    priorReads,
    requested: [1, 50],
    currentHash: "h1",
    compactedAt: 200,
  });
  assert.equal(d.deny, false);
});

test("dedupeDecision: disjoint prior partial reads together cover a later read", () => {
  const priorReads = [
    { hash: "h1", start: 1, end: 30, at: 100 },
    { hash: "h1", start: 31, end: 60, at: 110 },
  ];
  const d = dedupeDecision({
    priorReads,
    requested: [20, 40],
    currentHash: "h1",
  });
  assert.equal(d.deny, true);
});

test("dedupeDecision: no prior read of this file is allowed", () => {
  const d = dedupeDecision({ priorReads: [], requested: [1, 50], currentHash: "h1" });
  assert.equal(d.deny, false);
});
