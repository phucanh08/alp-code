import { toJSONSchema, type ZodType } from "zod";
import type { OutputContract, OutputValidation } from "../agents/types";

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "output" : path.map(String).join(".");
}

export function defineOutputContract<TOutput>(
  name: string,
  schema: ZodType<TOutput>,
): OutputContract<TOutput> {
  return Object.freeze({
    name,
    schema: toJSONSchema(schema) as Readonly<Record<string, unknown>>,
    validate(value: unknown): OutputValidation<TOutput> {
      const result = schema.safeParse(value);
      if (result.success) {
        return { ok: true, value: result.data };
      }
      return {
        ok: false,
        issues: Object.freeze(
          result.error.issues.map(
            (issue) => `${formatPath(issue.path)}: ${issue.message}`,
          ),
        ),
      };
    },
  });
}

export function validateOutput<TOutput>(
  contract: OutputContract<TOutput>,
  value: unknown,
): OutputValidation<TOutput> {
  return contract.validate(value);
}
