/**
 * Redaction chạy **trước** khi bất kỳ byte nào của transcript được ghi vào Thread.
 *
 * Bộ regex nhỏ, cố ý: mục tiêu là secret có hình dạng nhận ra được (token có prefix, private
 * key, header Authorization, `key=value` với tên gợi ý). Không cố bắt mọi entropy cao — cái
 * đó bắt nhầm hash, digest, ID, và làm history vô dụng. Fixture trong
 * `test/fixtures/thread-history/secrets.json` là hợp đồng.
 */
export const REDACTED = "[REDACTED]";

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const RULES: readonly Rule[] = [
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`,
  },
  {
    name: "authorization-header",
    pattern: /(authorization\s*[:=]\s*)(?:(basic|bearer|token)\s+)?([^\s,;"']+)/gi,
    replace: (_m, prefix: string, scheme?: string) => `${prefix}${scheme ? `${scheme} ` : ""}${REDACTED}`,
  },
  {
    name: "bearer-token",
    pattern: /\b(bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    name: "prefixed-token",
    // OpenAI/Anthropic `sk-…`, GitHub `ghp_/gho_/ghu_/ghs_/ghr_/github_pat_`, Slack `xox?-`,
    // AWS `AKIA…`, Google `AIza…`, npm `npm_`, Stripe `sk_live_/rk_live_`.
    pattern: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
    replace: () => REDACTED,
  },
  {
    name: "named-secret",
    pattern: /\b((?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
];

export interface RedactionResult {
  readonly text: string;
  readonly redactedCount: number;
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let redactedCount = 0;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      redactedCount += 1;
      return rule.replace(...(args as [string, ...string[]]));
    });
  }
  return { text, redactedCount };
}

/** Cắt theo byte UTF-8 mà không chẻ đôi một ký tự; đánh dấu khi có cắt. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = " …[truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    end += char.length;
  }
  return `${text.slice(0, end)}${marker}`;
}

/** Redact rồi cắt — theo thứ tự đó, để một token bị cắt đôi không lọt qua regex. */
export function sanitizeText(text: string, maxBytes: number): string {
  return truncateUtf8(redactSecrets(text).text, maxBytes);
}

/**
 * Redact từng string bên trong một giá trị JSON — dùng cho tool input trước khi stringify.
 * Redact sau stringify thì `\n` đã thành hai ký tự `\` `n`, và `\nAPI_KEY=` không còn ranh
 * giới từ để regex bắt.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, redactDeep(inner)]));
  }
  return value;
}
