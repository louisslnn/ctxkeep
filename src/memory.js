import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The memory file (default: CONTEXT.md at the project root) holds knowledge
 * that was EARNED during sessions and would otherwise be destroyed by
 * compaction: decisions and their reasons, approaches already ruled out,
 * non-obvious constraints discovered the hard way.
 *
 * It is deliberately not a second CLAUDE.md. Static conventions belong in
 * CLAUDE.md, which loads without running a script. This file is for the things
 * you only learn by working in the repo for an hour.
 *
 * It is plain markdown, committed to the repo, and readable by a human. If a
 * teammate can't skim it and understand the project's state, it has drifted
 * into being a cache rather than memory.
 */

const TEMPLATE = `# Project context

Durable knowledge for this repo, carried across sessions and compactions.
Keep entries short and factual. Delete anything that has stopped being true.

## Decisions

<!-- Choices that are settled, with the reason. Reasons prevent re-litigation. -->

## Constraints

<!-- Non-obvious rules discovered while working. "Migrations must run before seed." -->

## Ruled out

<!-- Approaches already tried and rejected, and why. This is the highest-value
     section: without it, every fresh context re-attempts the same dead ends. -->

## Open threads

<!-- Work in flight. Remove when done. -->
`;

export function memoryPath(config) {
  return join(config.projectRoot, config.memory.file);
}

export function readMemory(config) {
  const path = memoryPath(config);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function initMemory(config) {
  const path = memoryPath(config);
  if (existsSync(path)) return { created: false, path };
  writeFileSync(path, TEMPLATE, "utf8");
  return { created: true, path };
}

/**
 * Build the text injected via `additionalContext`.
 *
 * Two constraints shape this:
 *
 *  1. Hook output is capped at 10,000 characters. Over that, Claude Code writes
 *     the text to a file and passes a preview plus a path — which works, but
 *     costs a round trip. Staying under the cap keeps injection direct.
 *
 *  2. Phrasing must read as factual statements, not as out-of-band system
 *     commands. Text that looks like injected instructions can trip prompt
 *     injection defenses and get surfaced to the user instead of used.
 */
const PREFIX = "Accumulated context for this project, recorded in previous sessions:\n\n";

/**
 * Pack the memory file into an injectable digest and report what happened.
 *
 * Returns null when there is nothing to inject, otherwise:
 *   { digest, injectedChars, cap, keptSections, droppedSections }
 *
 * Truncation is SECTION-AWARE. Past the cap the old digest sliced at a raw
 * character offset, so a later section could be injected with its header but
 * only half its body — and the model can't tell a truncated fact from a
 * complete one. Instead we keep whole `## ` sections in order and drop the ones
 * that don't fit, whole. `doctor` uses the counts to warn before knowledge is
 * silently left out.
 */
export function packDigest(config) {
  const raw = readMemory(config);
  if (!raw) return null;

  // Everything before the first `##` is preamble written for a human reader.
  // It is not context, so it is neither injected nor counted as content.
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, "");
  const firstSection = stripped.indexOf("\n## ");
  if (firstSection === -1) return null;

  // Keep only sections that actually have entries. Injecting four empty
  // headings costs tokens and tells the model nothing.
  const sections = stripped
    .slice(firstSection)
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter((s) => {
      const lines = s.split("\n").slice(1);
      return lines.some((l) => l.trim() && !l.trimStart().startsWith("#"));
    });

  if (!sections.length) return null;

  // Budget the section body against the cap, leaving headroom for the framing
  // prefix and tail so the whole digest stays under the hook-output cap.
  const cap = Math.min(config.memory.maxInjectedChars, 9000);
  const budget = Math.max(0, cap - PREFIX.length - 240);

  const kept = [];
  let used = 0;
  for (const section of sections) {
    const join = kept.length ? 2 : 0; // "\n\n"
    if (used + join + section.length <= budget) {
      kept.push(section);
      used += join + section.length;
    }
    // A section that doesn't fit is dropped whole; smaller later sections may
    // still fit, so keep scanning rather than stopping at the first miss.
  }

  // Degenerate case: not even one section fits the soft budget. Keeping the
  // section WHOLE matters more than the soft cap, so emit the first one intact —
  // only trimming (at a line boundary) if it would breach Claude Code's hard
  // 10,000-char hook-output cap.
  if (kept.length === 0) {
    const HARD = 9500;
    let one = sections[0];
    if (one.length > HARD) {
      one = one.slice(0, HARD);
      const lastBreak = one.lastIndexOf("\n");
      if (lastBreak > HARD * 0.5) one = one.slice(0, lastBreak);
    }
    kept.push(one);
  }

  const dropped = sections.length - kept.length;
  const body = kept.join("\n\n");

  const tail =
    dropped > 0
      ? `\n\n(${dropped} further section${dropped === 1 ? "" : "s"} of ${config.memory.file} ` +
        `${dropped === 1 ? "is" : "are"} not shown here, to stay within the injection budget. ` +
        `The complete file is at ${config.memory.file}.)`
      : `\n\nThe source of this section is ${config.memory.file} in the project root.`;

  const digest = `${PREFIX}${body}${tail}`;
  return { digest, injectedChars: digest.length, cap, keptSections: kept.length, droppedSections: dropped };
}

/** The injectable text, or null when there is nothing to inject. */
export function buildDigest(config) {
  return packDigest(config)?.digest ?? null;
}
