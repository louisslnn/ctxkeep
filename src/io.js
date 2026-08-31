/**
 * Hook plumbing.
 *
 * The governing rule here is FAIL OPEN. A hook runs on every tool call. If it
 * throws, hangs, or prints malformed JSON, the user's session degrades — and
 * the failure mode of a context optimizer must never be "Claude Code stopped
 * working". Every entry point below swallows its own errors and exits 0 with
 * no output, which Claude Code reads as "this hook has no opinion".
 */

export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/** Claude Code caps hook output strings at 10,000 characters. */
export const HOOK_OUTPUT_CAP = 10000;

export function emit(json) {
  process.stdout.write(JSON.stringify(json));
}

export function passthrough() {
  process.exit(0);
}

/**
 * Extract text from a tool result.
 *
 * The exact shape of `tool_response` varies by tool and has changed across
 * Claude Code versions, so this probes the plausible shapes rather than
 * assuming one. Run `ctxkeep doctor` against a live session to confirm the
 * shape your version emits before tuning anything.
 */
export function extractText(toolResponse) {
  if (toolResponse == null) return null;
  if (typeof toolResponse === "string") return toolResponse;

  if (Array.isArray(toolResponse)) {
    const parts = toolResponse
      .map((b) => (typeof b === "string" ? b : b?.text))
      .filter((s) => typeof s === "string");
    return parts.length ? parts.join("\n") : null;
  }

  for (const key of ["content", "output", "stdout", "text", "result", "file"]) {
    const value = toolResponse[key];
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const nested = extractText(value);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Rebuild a tool_response of the original shape with new text, so
 * `updatedToolOutput` hands back something the same consumer can read.
 */
export function replaceText(toolResponse, newText) {
  if (typeof toolResponse === "string" || toolResponse == null) return newText;
  if (Array.isArray(toolResponse)) return [{ type: "text", text: newText }];

  for (const key of ["content", "output", "stdout", "text", "result"]) {
    if (typeof toolResponse[key] === "string") {
      return { ...toolResponse, [key]: newText };
    }
  }
  return newText;
}

/** Wrap a hook body so any failure becomes a silent no-op. */
export function guard(fn) {
  const timer = setTimeout(() => process.exit(0), 5000);
  timer.unref?.();

  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (process.env.CTXKEEP_DEBUG) {
        process.stderr.write(`ctxkeep: ${err.stack}\n`);
      }
      process.exit(0);
    });
}
