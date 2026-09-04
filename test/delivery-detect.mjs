// Delivery detector for test/delivery-check.sh.
//
// Given a session transcript and a target filename, decides what the MODEL
// actually received as the Read of that file — by matching the Read tool_use to
// its tool_result and inspecting the DELIVERED content, not anything the hook
// merely emitted. This is the distinction that a naive `grep [ctxkeep] transcript`
// misses: the pointer string can appear elsewhere in the log, so grep cannot
// fail when delivery breaks. Parsing the specific tool_result can.
//
// Usage:   node delivery-detect.mjs <transcript.jsonl> <target-filename>
// Exit:    0 = the delivered Read was pruned (pointer + elision present)
//          1 = the delivered Read was the full file (delivery failure)
//          3 = no Read of the target found in the transcript
import { readFileSync } from "node:fs";

const [transcript, target] = process.argv.slice(2);
if (!transcript || !target) {
  console.error("usage: node delivery-detect.mjs <transcript.jsonl> <target-filename>");
  process.exit(2);
}

const lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean);

// tool_use_id -> file_path, for Read calls whose path ends with the target name.
const readIds = new Map();
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { continue; }
  if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b.type === "tool_use" && b.name === "Read" && String(b.input?.file_path || "").endsWith(target)) {
        readIds.set(b.id, b.input.file_path);
      }
    }
  }
}

// The delivered result the model consumed for that Read.
let verdict = null;
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { continue; }
  if (o.type === "user" && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b.type === "tool_result" && readIds.has(b.tool_use_id)) {
        const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        const nLines = (content.match(/\n/g) || []).length;
        const pruned = content.includes("[ctxkeep]") && content.includes("elided");
        verdict = { file: readIds.get(b.tool_use_id), nLines, len: content.length, pruned };
      }
    }
  }
}

if (!verdict) {
  console.error(`no delivered Read of *${target} found in ${transcript}`);
  process.exit(3);
}

if (verdict.pruned) {
  console.log(`DELIVERED PRUNED: ${verdict.file} -> ${verdict.nLines} lines, ${verdict.len} chars, [ctxkeep] pointer present.`);
  process.exit(0);
}
console.log(`DELIVERED FULL: ${verdict.file} -> ${verdict.nLines} lines, ${verdict.len} chars, no pointer. Pruning did NOT reach the model.`);
process.exit(1);
