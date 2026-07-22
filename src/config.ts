import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import YAML from "yaml";

import type {
  BridgeConfig,
  DirectoryRules,
  FileRules,
  OverlayFile,
  RuleMatcher,
  RuleValue,
} from "./types.js";

const DIRECTORY_RULE_FILE = ".astro-theme-bridge.yaml";
const PROJECT_CONFIG_FILE = "astro-theme-bridge.yaml";
const SPECIAL_NAMES = new Set([
  DIRECTORY_RULE_FILE,
  PROJECT_CONFIG_FILE,
  ".astro-theme-bridge",
  ".git",
  "node_modules",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizePatterns(value: unknown, filePath: string, key: string): string[] {
  if (typeof value === "string") {
    return value.length === 0 ? [] : [value];
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.filter((item) => item.length > 0);
  }

  throw new Error(`${filePath}: ${key} must be a string or an array of strings.`);
}

async function readYamlObject(filePath: string): Promise<Record<string, unknown>> {
  const contents = await readFile(filePath, "utf8");
  const parsed = YAML.parse(contents);

  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a YAML object.`);
  }

  return parsed;
}

export async function loadProjectConfig(projectRoot: string): Promise<BridgeConfig> {
  const configPath = path.join(projectRoot, PROJECT_CONFIG_FILE);

  try {
    return (await readYamlObject(configPath)) as BridgeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing ${PROJECT_CONFIG_FILE}. Run \`astro-theme-bridge init\` first.`);
    }

    throw error;
  }
}

function applyRuleValue(
  current: RuleMatcher | undefined,
  config: Record<string, unknown>,
  key: keyof FileRules,
  directory: string,
  filePath: string,
): RuleMatcher | undefined {
  if (!hasOwn(config, key)) {
    return current;
  }

  const value = config[key] as RuleValue;
  return {
    baseDirectory: directory,
    patterns: normalizePatterns(value, filePath, key),
  };
}

function applyRules(
  current: FileRules,
  config: Record<string, unknown>,
  directory: string,
  filePath: string,
): FileRules {
  const nextRules: FileRules = {};
  const include = applyRuleValue(current.include, config, "include", directory, filePath);
  const exclude = applyRuleValue(current.exclude, config, "exclude", directory, filePath);
  const merge = applyRuleValue(current.merge, config, "merge", directory, filePath);
  const remove = applyRuleValue(current.remove, config, "remove", directory, filePath);

  if (include) {
    nextRules.include = include;
  }
  if (exclude) {
    nextRules.exclude = exclude;
  }
  if (merge) {
    nextRules.merge = merge;
  }
  if (remove) {
    nextRules.remove = remove;
  }

  return nextRules;
}

async function readDirectoryRules(directory: string): Promise<Record<string, unknown> | undefined> {
  const rulePath = path.join(directory, DIRECTORY_RULE_FILE);

  try {
    return await readYamlObject(rulePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function containsHiddenSegment(filePath: string): boolean {
  return filePath.split(path.sep).some((segment) => segment.startsWith("."));
}

function isSpecialName(name: string): boolean {
  return SPECIAL_NAMES.has(name);
}

function matches(matcher: RuleMatcher, absolutePath: string): boolean {
  const relativePath = path.relative(matcher.baseDirectory, absolutePath);

  if (relativePath === "" || relativePath.startsWith(`..${path.sep}`) || relativePath === "..") {
    return false;
  }

  return ignore().add(matcher.patterns).ignores(toPosixPath(relativePath));
}

function shouldInclude(filePath: string, projectRoot: string, rules: FileRules): boolean {
  if (rules.include && rules.include.patterns.length > 0) {
    return matches(rules.include, filePath);
  }

  return !containsHiddenSegment(path.relative(projectRoot, filePath));
}

function shouldExclude(filePath: string, rules: FileRules): boolean {
  return Boolean(rules.exclude && rules.exclude.patterns.length > 0 && matches(rules.exclude, filePath));
}

export function shouldOverlay(filePath: string, projectRoot: string, rules: FileRules): boolean {
  return shouldInclude(filePath, projectRoot, rules) && !shouldExclude(filePath, rules);
}

export function shouldMerge(filePath: string, rules: FileRules): boolean {
  if (rules.merge && rules.merge.patterns.length > 0) {
    return matches(rules.merge, filePath);
  }

  return [".json", ".yaml", ".yml"].includes(path.extname(filePath).toLowerCase());
}

export function shouldRemove(filePath: string, rules: FileRules): boolean {
  return Boolean(rules.remove && rules.remove.patterns.length > 0 && matches(rules.remove, filePath));
}

export function rulesForProjectPath(
  projectRoot: string,
  relativePath: string,
  directoryRules: DirectoryRules[],
): FileRules {
  let matchingRules = directoryRules[0]?.rules ?? {};
  let longestMatch = -1;

  for (const directoryRule of directoryRules) {
    const relativeDirectory = path.relative(projectRoot, directoryRule.directory);
    const applies = relativeDirectory === "" || relativePath.startsWith(`${relativeDirectory}${path.sep}`);
    if (applies && relativeDirectory.length > longestMatch) {
      matchingRules = directoryRule.rules;
      longestMatch = relativeDirectory.length;
    }
  }

  return matchingRules;
}

async function rootRules(projectRoot: string, projectConfig: BridgeConfig): Promise<FileRules> {
  const rootConfigPath = path.join(projectRoot, PROJECT_CONFIG_FILE);
  let rules = applyRules({}, projectConfig as Record<string, unknown>, projectRoot, rootConfigPath);
  const rootDirectoryRules = await readDirectoryRules(projectRoot);

  if (rootDirectoryRules) {
    rules = applyRules(rules, rootDirectoryRules, projectRoot, path.join(projectRoot, DIRECTORY_RULE_FILE));
  }

  return rules;
}

export async function collectDirectoryRules(
  projectRoot: string,
  projectConfig: BridgeConfig,
): Promise<DirectoryRules[]> {
  const directories: DirectoryRules[] = [];

  async function walk(directory: string, inheritedRules: FileRules): Promise<void> {
    directories.push({ directory, rules: inheritedRules });
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || isSpecialName(entry.name)) {
        continue;
      }

      const childDirectory = path.join(directory, entry.name);
      const directoryRules = await readDirectoryRules(childDirectory);
      const rules = directoryRules
        ? applyRules(inheritedRules, directoryRules, childDirectory, path.join(childDirectory, DIRECTORY_RULE_FILE))
        : inheritedRules;
      await walk(childDirectory, rules);
    }
  }

  await walk(projectRoot, await rootRules(projectRoot, projectConfig));
  return directories;
}

export async function collectOverlayFiles(
  projectRoot: string,
  projectConfig: BridgeConfig,
): Promise<OverlayFile[]> {
  const files: OverlayFile[] = [];

  for (const { directory, rules } of await collectDirectoryRules(projectRoot, projectConfig)) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (isSpecialName(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        continue;
      }

      if (!entry.isFile() || !shouldInclude(absolutePath, projectRoot, rules)) {
        continue;
      }

      if (shouldOverlay(absolutePath, projectRoot, rules)) {
        files.push({
          absolutePath,
          relativePath: path.relative(projectRoot, absolutePath),
          rules,
        });
      }
    }
  }

  return files;
}
