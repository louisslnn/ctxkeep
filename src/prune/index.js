import { pruneLines, pruneChars } from "./lines.js";
import { estimateTokens } from "../tokenize.js";
import { stashArtifact } from "../store.js";

/**
 * Decide whether an artifact should be pruned, and if so return the
 * replacement text plus the accounting.
 *
 * The replacement always ends with a retrieval pointer. Pruning is only safe
 * because it is reversible: the model must be able to get the full text back
 * when the elided middle turns out to matter. The bundled skill teaches it how.
 */
export function pruneToolOutput({ config, toolName, toolUseId, text, filePath }) {
  const result = {
    pruned: false,
    text,
    originalTokens: estimateTokens(text),
    newTokens: estimateTokens(text),
    saved: 0,
  };

  if (!config.enabled) return result;
  if (config.neverPrune?.includes(toolName)) return result;

  // Never prune reads of the cache itself, or expansion becomes a loop.
  const target = filePath || "";
  if (config.passthroughPaths?.some((p) => target.includes(p))) return result;

  const rule = config.prune[toolName] ?? config.prune.default;
  const outcome = rule.maxLines ? pruneLines(text, rule) : pruneChars(text, rule);
  if (!outcome.pruned) return result;

  const cached = stashArtifact(config, toolUseId, text);
  const relative = cached.replace(config.projectRoot + "/", "");

  const pointer =
    `\n\n---\n[ctxkeep] This output was shortened to save context. ` +
    `Full result (${outcome.originalLines ?? outcome.originalChars} ` +
    `${outcome.originalLines ? "lines" : "chars"}) is at: ${relative}\n` +
    `Read that path if the elided section matters. It is exempt from pruning.`;

  const finalText = outcome.text + pointer;
  const newTokens = estimateTokens(finalText);

  return {
    pruned: true,
    text: finalText,
    cachedAt: relative,
    originalTokens: result.originalTokens,
    newTokens,
    saved: Math.max(0, result.originalTokens - newTokens),
    detail: outcome,
  };
}
