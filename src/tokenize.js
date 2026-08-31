/**
 * Cheap token estimate.
 *
 * This is deliberately NOT a real tokenizer. A hook spawns on every tool call,
 * so process startup is the dominant cost; loading a BPE vocabulary would add
 * more latency than the pruning saves. The estimate only needs to be good
 * enough to rank artifacts and report savings.
 *
 * Rule of thumb: ~4 chars/token for prose, ~3 for code and structured text,
 * which have more punctuation and fewer whole words.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  const punctuation = (text.match(/[^\w\s]/g) || []).length;
  const density = punctuation / Math.max(chars, 1);
  const charsPerToken = density > 0.12 ? 3.0 : 4.0;
  return Math.ceil(chars / charsPerToken);
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
