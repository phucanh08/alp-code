import { parse as parseYaml } from "yaml";
import { agentFileSchema, type AgentFile } from "./schema";

/**
 * A definition is data, and 32 KiB is already far more than the budgeted fields can hold.
 * Checked before the parser sees the text: the cheapest refusal is the one that never
 * allocates.
 */
export const AGENT_FILE_MAX_BYTES = 32 * 1024;

export type AgentFileParse =
  | { readonly ok: true; readonly file: AgentFile }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * YAML, parsed with every convenience that is also an attack turned off.
 *
 * This runs on a file that is untrusted by definition (§5.6): the agent lives in a repo, and
 * a repo can be cloned from anywhere. Trust happens *after* this, so the parser is the first
 * thing an attacker reaches and the last one that may be lenient.
 *
 * Verified against `yaml@2.9`, not assumed:
 * - `maxAliasCount: 0` → "Alias resolution is disabled". No anchors, so no billion-laughs
 *   expansion; the library's own default (100) still parses a four-level bomb.
 * - Duplicate keys throw by default, so `tools:` cannot be declared twice with only the
 *   second one taking effect.
 * - `parse` refuses a multi-document stream, so a second document cannot ride along.
 * - Explicit tags (`!!binary`) still resolve to host objects. Left to the schema below
 *   rather than pre-filtered: a `Buffer` where a string is required fails `z.string()`, and
 *   a filter over raw text would be the fragile half of a defence the schema already holds.
 */
export function parseAgentFile(source: string): AgentFileParse {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > AGENT_FILE_MAX_BYTES) {
    return { ok: false, issues: [`agent file is ${bytes} bytes, over the ${AGENT_FILE_MAX_BYTES} byte limit`] };
  }

  let document: unknown;
  try {
    document = parseYaml(source, {
      version: "1.2",
      schema: "core",
      maxAliasCount: 0,
      uniqueKeys: true,
      prettyErrors: false,
    });
  } catch (error) {
    return { ok: false, issues: [`yaml: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const result = agentFileSchema.safeParse(document);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path === "" ? issue.message : `${path}: ${issue.message}`;
      }),
    };
  }
  return { ok: true, file: result.data };
}
