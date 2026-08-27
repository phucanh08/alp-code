const RAW_RUNTIME_TOOL = /(?:^|__)(?:herdr|paseo|create_agent|spawn_agent)(?:__|$)/i;
const INDIRECT_COMMAND =
  /(^|[^\w])eval[^\w]|`|\$(?:\(|[A-Za-z_{])|[<>]\(|\bbase64\b|\bxxd\b|\b(?:sh|bash|zsh|python3?|node)\s+-c\b|\bperl\s+-e\b|\bruby\s+-e\b|\bxargs\b/;
const RUNTIME_BINARY = /^(?:herdr|paseo(?:\.exe)?)$/i;
const SHELL_WRAPPER = /^(?:env|command|sudo)$/;

export const POLICY_GUARDRAIL_LIMITATION =
  "Command inspection is a guardrail, not hostile-process isolation; use an OS sandbox or container for adversarial code.";

export function isRawRuntimeTool(tool: string): boolean {
  return RAW_RUNTIME_TOOL.test(tool);
}

export function hasIndirectCommand(command: string): boolean {
  return INDIRECT_COMMAND.test(command);
}

export function invokesRawRuntime(command: string): boolean {
  for (const segment of command.split(/[;\n]|&&|\|\||\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index])) index++;
    while (index < words.length && SHELL_WRAPPER.test(words[index])) index++;
    const binary = words[index]?.replace(/^['"]|['"]$/g, "").split("/").at(-1);
    if (binary && RUNTIME_BINARY.test(binary)) return true;
  }
  return false;
}
