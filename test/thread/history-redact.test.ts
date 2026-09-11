import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets, sanitizeText, truncateUtf8 } from "../../src/thread/history-redact";

describe("history redaction", () => {
  it.each([
    ["GitHub token", "push with ghp_abcdefghijklmnopqrstuvwxyz0123456789 please", `push with ${REDACTED} please`],
    ["OpenAI/Anthropic key", "key sk-ant-api03-abcdefghijklmnopqrstu end", `key ${REDACTED} end`],
    ["AWS access key", "AKIAIOSFODNN7EXAMPLE is mine", `${REDACTED} is mine`],
    ["Authorization header", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh.ijklmnop", `Authorization: Bearer ${REDACTED}`],
    ["bare bearer", "use bearer abcdefghijklmnopqrstuvwxyz", `use bearer ${REDACTED}`],
    ["named secret", "API_KEY=supersecretvalue123 and password: hunter2hunter2", `API_KEY=${REDACTED} and password: ${REDACTED}`],
  ])("redacts %s", (_label, input, expected) => {
    const result = redactSecrets(input);
    expect(result.text).toBe(expected);
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it("redacts a private key block as a whole", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(`here:\n${key}\nend`);
    expect(result.text).not.toContain("MIIEow");
    expect(result.text).toContain(REDACTED);
    expect(result.redactedCount).toBe(1);
  });

  it("leaves ordinary text alone", () => {
    const text = "Refactor the token parser; password field is required in the form.";
    expect(redactSecrets(text)).toEqual({ text, redactedCount: 0 });
  });

  it("truncates by UTF-8 bytes without splitting a character", () => {
    const text = "é".repeat(100); // 200 bytes
    const cut = truncateUtf8(text, 60);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(60);
    expect(cut.endsWith(" …[truncated]")).toBe(true);
    expect(cut).not.toContain("�");
    expect(truncateUtf8("short", 60)).toBe("short");
  });

  it("redacts before truncating so a cut token cannot slip through", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const text = `x ${token}`;
    // Cắt ở giữa token: nếu cắt trước, regex không còn khớp và token lộ một nửa.
    const out = sanitizeText(text, 20);
    expect(out).not.toContain("ghp_abc");
    expect(out.startsWith(`x ${REDACTED}`.slice(0, 5))).toBe(true);
  });
});
