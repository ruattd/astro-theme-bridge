import { copyFile, cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  collectDirectoryRules,
  collectOverlayFiles,
  loadProjectConfig,
  rulesForProjectPath,
  shouldMerge,
  shouldOverlay,
  shouldRemove,
} from "./config.js";
import { mergeStructuredFiles } from "./merge.js";
import { ensureThemeDirectory, parseThemeSource } from "./source.js";
import type { BridgeConfig, BuildOptions, BuildResult, DirectoryRules, FileRules, ThemeSource } from "./types.js";

const BRIDGE_DIRECTORY_NAME = ".astro-theme-bridge";
const MERGED_DIRECTORY_NAME = "merged";
const SPECIAL_NAMES = new Set([
  ".astro-theme-bridge.yaml",
  "astro-theme-bridge.yaml",
  ".astro-theme-bridge",
  ".git",
  "node_modules",
]);

function isSpecialRelativePath(relativePath: string): boolean {
  if (relativePath === "") {
    return false;
  }

  return relativePath.split(path.sep).some((segment) => SPECIAL_NAMES.has(segment));
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function sourceFromConfig(config: BridgeConfig, projectRoot: string): ThemeSource {
  if (config.theme && config.source && config.theme !== config.source) {
    throw new Error("Use either theme or source in astro-theme-bridge.yaml, not both.");
  }

  const rawSource = config.theme ?? config.source;
  if (!rawSource || rawSource.trim() === "") {
    throw new Error("astro-theme-bridge.yaml must define a theme source.");
  }

  return parseThemeSource(rawSource, projectRoot);
}

async function cleanMergedDirectory(mergedDirectory: string, cleanDependencies: boolean): Promise<void> {
  await mkdir(mergedDirectory, { recursive: true });
  const entries = await readdir(mergedDirectory, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    if (!cleanDependencies && entry.name === "node_modules") {
      return;
    }

    await rm(path.join(mergedDirectory, entry.name), { recursive: true, force: true });
  }));
}

async function copyThemeDirectory(themeDirectory: string, mergedDirectory: string): Promise<void> {
  const entries = await readdir(themeDirectory, { withFileTypes: true });

  await Promise.all(entries
    .filter((entry) => !SPECIAL_NAMES.has(entry.name))
    .map(async (entry) => {
      const sourcePath = path.join(themeDirectory, entry.name);
      const destinationPath = path.join(mergedDirectory, entry.name);
      await cp(sourcePath, destinationPath, {
        recursive: entry.isDirectory(),
        force: true,
        filter: (candidate) => !isSpecialRelativePath(path.relative(themeDirectory, candidate)),
      });
    }));
}

function isStructuredFile(filePath: string): boolean {
  return [".json", ".yaml", ".yml"].includes(path.extname(filePath).toLowerCase());
}

async function removeThemeFiles(
  mergedDirectory: string,
  projectRoot: string,
  directoryRules: DirectoryRules[],
): Promise<number> {
  let removedFiles = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (SPECIAL_NAMES.has(entry.name)) {
        continue;
      }

      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(mergedDirectory, filePath);
      const rules = rulesForProjectPath(projectRoot, relativePath, directoryRules);
      if (shouldRemove(path.join(projectRoot, relativePath), rules)) {
        await rm(filePath, { force: true });
        removedFiles += 1;
      }
    }
  }

  await walk(mergedDirectory);
  return removedFiles;
}

interface OverlaySyncResult {
  copied: boolean;
  merged: boolean;
}

async function applyOverlayFile(
  projectRoot: string,
  themeDirectory: string,
  mergedDirectory: string,
  overlayFile: { absolutePath: string; relativePath: string; rules: FileRules },
): Promise<OverlaySyncResult> {
  const destinationPath = path.join(mergedDirectory, overlayFile.relativePath);
  const themePath = path.join(themeDirectory, overlayFile.relativePath);
  const merge = shouldMerge(overlayFile.absolutePath, overlayFile.rules);

  if (merge && !isStructuredFile(overlayFile.absolutePath)) {
    throw new Error(`Cannot merge ${overlayFile.relativePath}: only JSON and YAML files are supported.`);
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  const useThemeBase = !shouldRemove(overlayFile.absolutePath, overlayFile.rules) && await isFile(themePath);
  if (merge && useThemeBase) {
    await copyFile(themePath, destinationPath);
    await mergeStructuredFiles(destinationPath, overlayFile.absolutePath);
    return { copied: false, merged: true };
  }

  await copyFile(overlayFile.absolutePath, destinationPath);
  return { copied: true, merged: false };
}

async function restoreThemeFile(
  projectRoot: string,
  themeDirectory: string,
  mergedDirectory: string,
  relativePath: string,
  rules: FileRules,
): Promise<void> {
  const destinationPath = path.join(mergedDirectory, relativePath);
  const themePath = path.join(themeDirectory, relativePath);

  if (shouldRemove(path.join(projectRoot, relativePath), rules) || !await isFile(themePath)) {
    await rm(destinationPath, { force: true });
    return;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(themePath, destinationPath);
}

function normalizeProjectRelativePath(relativePath: string): string {
  const normalizedPath = path.normalize(relativePath);
  if (
    normalizedPath === "."
    || path.isAbsolute(normalizedPath)
    || normalizedPath === ".."
    || normalizedPath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Invalid project-relative path: ${relativePath}`);
  }

  return normalizedPath;
}

export function bridgePaths(projectRoot: string): { bridgeDirectory: string; mergedDirectory: string } {
  const bridgeDirectory = path.join(projectRoot, BRIDGE_DIRECTORY_NAME);
  return {
    bridgeDirectory,
    mergedDirectory: path.join(bridgeDirectory, MERGED_DIRECTORY_NAME),
  };
}

export async function buildProject(projectDirectory = process.cwd(), options: BuildOptions = {}): Promise<BuildResult> {
  const projectRoot = path.resolve(projectDirectory);
  const config = await loadProjectConfig(projectRoot);
  const source = sourceFromConfig(config, projectRoot);
  const { bridgeDirectory, mergedDirectory } = bridgePaths(projectRoot);
  const themeDirectory = await ensureThemeDirectory(source, bridgeDirectory);

  if (path.resolve(themeDirectory) === path.resolve(mergedDirectory)) {
    throw new Error("The theme source cannot be the merged directory.");
  }

  await cleanMergedDirectory(mergedDirectory, options.clean === true);
  await copyThemeDirectory(themeDirectory, mergedDirectory);

  const directoryRules = await collectDirectoryRules(projectRoot, config);
  const removedFiles = await removeThemeFiles(mergedDirectory, projectRoot, directoryRules);
  const overlayFiles = await collectOverlayFiles(projectRoot, config);
  let copiedFiles = 0;
  let mergedFiles = 0;

  for (const overlayFile of overlayFiles) {
    const result = await applyOverlayFile(projectRoot, themeDirectory, mergedDirectory, overlayFile);
    if (result.merged) {
      mergedFiles += 1;
    }
    if (result.copied) {
      copiedFiles += 1;
    }
  }

  return { mergedDirectory, copiedFiles, mergedFiles, removedFiles };
}

export async function syncProjectFile(projectDirectory: string, relativePath: string): Promise<void> {
  const projectRoot = path.resolve(projectDirectory);
  const normalizedPath = normalizeProjectRelativePath(relativePath);
  const config = await loadProjectConfig(projectRoot);
  const source = sourceFromConfig(config, projectRoot);
  const { bridgeDirectory, mergedDirectory } = bridgePaths(projectRoot);
  const themeDirectory = await ensureThemeDirectory(source, bridgeDirectory);
  const directoryRules = await collectDirectoryRules(projectRoot, config);
  const rules = rulesForProjectPath(projectRoot, normalizedPath, directoryRules);
  const sourcePath = path.join(projectRoot, normalizedPath);

  if (await isFile(sourcePath) && shouldOverlay(sourcePath, projectRoot, rules)) {
    await applyOverlayFile(projectRoot, themeDirectory, mergedDirectory, {
      absolutePath: sourcePath,
      relativePath: normalizedPath,
      rules,
    });
    return;
  }

  await restoreThemeFile(projectRoot, themeDirectory, mergedDirectory, normalizedPath, rules);
}

export async function updateTheme(projectDirectory = process.cwd()): Promise<void> {
  const projectRoot = path.resolve(projectDirectory);
  const config = await loadProjectConfig(projectRoot);
  const source = sourceFromConfig(config, projectRoot);
  const { bridgeDirectory } = bridgePaths(projectRoot);
  await ensureThemeDirectory(source, bridgeDirectory, true);
}
