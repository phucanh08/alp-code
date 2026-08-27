export const PRINCIPAL_CONTEXT = Object.freeze({
  name: "Lê Phúc Anh",
  language: "Vietnamese",
  timezone: "Asia/Ho_Chi_Minh",
});

export function principalInstruction(): string {
  return `Serve ${PRINCIPAL_CONTEXT.name}. Communicate in Vietnamese, keep technical terms in English, and lead with the verified outcome.`;
}
