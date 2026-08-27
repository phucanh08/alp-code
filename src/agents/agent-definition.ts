import type { AgentDefinition } from "./types";

function cloneDefinitionValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneDefinitionValue) as T;
  }

  if (value !== null && typeof value === "object") {
    const clone: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      clone[key] = cloneDefinitionValue(
        (value as Record<PropertyKey, unknown>)[key],
      );
    }
    return clone as T;
  }

  return value;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }

  return Object.freeze(value);
}

export function defineAgent<TOutput>(
  definition: AgentDefinition<TOutput>,
): AgentDefinition<TOutput> {
  return deepFreeze(cloneDefinitionValue(definition));
}
