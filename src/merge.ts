import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mergeObjects(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = clone(base);

  for (const [rawKey, sourceValue] of Object.entries(overlay)) {
    if (rawKey.startsWith("~")) {
      delete result[rawKey.slice(1)];
      continue;
    }

    if (rawKey.startsWith("^")) {
      result[rawKey.slice(1)] = clone(sourceValue);
      continue;
    }

    const prepend = rawKey.startsWith("+");
    const append = rawKey.endsWith("+");
    const key = rawKey.slice(prepend ? 1 : 0, append ? -1 : undefined);

    if (prepend || append) {
      if (!Array.isArray(sourceValue)) {
        throw new Error(`Array merge key \`${rawKey}\` must have an array value.`);
      }

      const baseValue = result[key];
      if (baseValue !== undefined && !Array.isArray(baseValue)) {
        throw new Error(`Array merge key \`${rawKey}\` conflicts with a non-array value.`);
      }

      result[key] = prepend
        ? [...clone(sourceValue), ...(baseValue ? clone(baseValue) : [])]
        : [...(baseValue ? clone(baseValue) : []), ...clone(sourceValue)];
      continue;
    }

    const baseValue = result[key];
    if (isPlainObject(sourceValue)) {
      result[key] = mergeObjects(isPlainObject(baseValue) ? baseValue : {}, sourceValue);
      continue;
    }

    result[key] = clone(sourceValue);
  }

  return result;
}

export function mergeStructured(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(overlay)) {
    return clone(overlay);
  }

  return mergeObjects(isPlainObject(base) ? base : {}, overlay);
}

function parseStructured(filePath: string, contents: string): unknown {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".json") {
    return JSON.parse(contents) as unknown;
  }

  if (extension === ".yaml" || extension === ".yml") {
    return YAML.parse(contents);
  }

  throw new Error(`Cannot merge ${filePath}: only JSON and YAML files are supported.`);
}

function stringifyStructured(filePath: string, value: unknown): string {
  return path.extname(filePath).toLowerCase() === ".json"
    ? `${JSON.stringify(value, null, 2)}\n`
    : YAML.stringify(value);
}

export async function mergeStructuredFiles(basePath: string, overlayPath: string): Promise<void> {
  const [baseContents, overlayContents] = await Promise.all([
    readFile(basePath, "utf8"),
    readFile(overlayPath, "utf8"),
  ]);
  const merged = mergeStructured(
    parseStructured(basePath, baseContents),
    parseStructured(overlayPath, overlayContents),
  );

  await writeFile(basePath, stringifyStructured(basePath, merged), "utf8");
}
