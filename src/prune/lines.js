/**
 * Head/tail line pruner.
 *
 * The middle of a long artifact is usually the least load-bearing part: the
 * top carries imports, signatures and the start of output; the bottom carries
 * results, totals and the final error. What sits between them is body text the
 * model can retrieve on demand.
 *
 * `keepMatching` overrides that for lines that must survive regardless of
 * position — a failing assertion 900 lines into a test run is the entire
 * reason the command was executed.
 */
export function pruneLines(text, rule) {
  const lines = text.split("\n");
  const max = rule.maxLines ?? 400;
  if (lines.length <= max) return { text, pruned: false };

  const head = rule.headLines ?? Math.floor(max * 0.7);
  const tail = rule.tailLines ?? Math.floor(max * 0.3);

  const keepRe = rule.keepMatching ? new RegExp(rule.keepMatching, "i") : null;

  const kept = new Set();
  for (let i = 0; i < head && i < lines.length; i++) kept.add(i);
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) kept.add(i);

  let salvaged = 0;
  if (keepRe) {
    const budget = rule.maxKeepMatching ?? 40;
    for (let i = head; i < lines.length - tail && salvaged < budget; i++) {
      if (keepRe.test(lines[i])) {
        kept.add(i);
        salvaged++;
      }
    }
  }

  // The elision marker states the ORIGINAL 1-based source line range it stands
  // in for. Read content reaches the hook without line-number prefixes, so once
  // the middle is elided the surviving tail would otherwise be renumbered on
  // display and a model reasoning about line positions would be wrong. Naming
  // the elided range keeps every kept line's true position recoverable: the head
  // is lines 1..headLines and the tail begins one past the last marker's range.
  const marker = (startIdx, count) => {
    const from = startIdx + 1;
    const to = startIdx + count;
    const range = count === 1 ? `original line ${from}` : `original lines ${from}-${to}`;
    return `… ${count} line${count === 1 ? "" : "s"} elided … (${range})`;
  };

  const out = [];
  let gap = 0;
  let gapStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (kept.has(i)) {
      if (gap > 0) {
        out.push(marker(gapStart, gap));
        gap = 0;
      }
      out.push(lines[i]);
    } else {
      if (gap === 0) gapStart = i;
      gap++;
    }
  }
  if (gap > 0) out.push(marker(gapStart, gap));

  return {
    text: out.join("\n"),
    pruned: true,
    originalLines: lines.length,
    keptLines: kept.size,
    salvaged,
  };
}

export function pruneChars(text, rule) {
  const max = rule.maxChars ?? 16000;
  if (text.length <= max) return { text, pruned: false };
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return {
    text:
      text.slice(0, head) +
      `\n… ${text.length - max} characters elided …\n` +
      text.slice(text.length - tail),
    pruned: true,
    originalChars: text.length,
  };
}
