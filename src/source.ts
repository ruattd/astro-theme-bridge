import { stat, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { GitHubThemeSource, LocalThemeSource, ThemeSource } from "./types.js";

interface GitHubCacheMetadata {
  source: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }

    throw error;
  }
}

export function parseThemeSource(rawSource: string, projectRoot: string): ThemeSource {
  const source = rawSource.trim();
  const separatorIndex = source.indexOf(":");

  if (separatorIndex <= 0) {
    throw new Error(`Invalid theme source \`${rawSource}\`. Expected a source such as github:owner/repo@ref or local:path.`);
  }

  const identifier = source.slice(0, separatorIndex);
  const value = source.slice(separatorIndex + 1);

  if (identifier === "local") {
    if (value.length === 0) {
      throw new Error("A local source must include a directory path.");
    }

    const localSource: LocalThemeSource = {
      kind: "local",
      directory: path.resolve(projectRoot, value),
      raw: source,
    };
    return localSource;
  }

  if (identifier === "github") {
    const match = /^([^/@\s]+)\/([^/@\s]+)(?:@(.+))?$/.exec(value);
    if (!match) {
      throw new Error(`Invalid GitHub source \`${rawSource}\`. Expected github:owner/repository@ref.`);
    }

    const owner = match[1];
    const repository = match[2];
    const ref = match[3];
    if (!owner || !repository) {
      throw new Error(`Invalid GitHub source \`${rawSource}\`. Expected github:owner/repository@ref.`);
    }

    const githubSource: GitHubThemeSource = {
      kind: "github",
      owner,
      repository,
      ...(ref ? { ref } : {}),
      raw: source,
    };
    return githubSource;
  }

  throw new Error(`Unsupported theme source identifier \`${identifier}\`.`);
}

async function runGit(args: string[], workingDirectory?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: workingDirectory,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function readCacheMetadata(metadataPath: string): Promise<GitHubCacheMetadata | undefined> {
  try {
    return JSON.parse(await readFile(metadataPath, "utf8")) as GitHubCacheMetadata;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }

    throw error;
  }
}

async function cacheGitHubSource(
  source: GitHubThemeSource,
  bridgeDirectory: string,
  refresh: boolean,
): Promise<string> {
  const cacheDirectory = path.join(bridgeDirectory, "github-repo");
  const metadataPath = path.join(bridgeDirectory, "github-source.json");
  const metadata = await readCacheMetadata(metadataPath);
  const cacheIsCurrent = metadata?.source === source.raw && await isDirectory(cacheDirectory);

  if (refresh || !cacheIsCurrent) {
    await rm(cacheDirectory, { recursive: true, force: true });
    await rm(metadataPath, { force: true });
    await mkdir(bridgeDirectory, { recursive: true });

    const repositoryUrl = `https://github.com/${source.owner}/${source.repository}.git`;
    try {
      if (source.ref) {
        await runGit(["clone", "--no-checkout", repositoryUrl, cacheDirectory]);
        await runGit(["checkout", "--detach", source.ref], cacheDirectory);
      } else {
        await runGit(["clone", "--depth", "1", repositoryUrl, cacheDirectory]);
      }
      await writeFile(metadataPath, `${JSON.stringify({ source: source.raw }, null, 2)}\n`, "utf8");
    } catch (error) {
      await rm(cacheDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  return cacheDirectory;
}

export async function ensureThemeDirectory(
  source: ThemeSource,
  bridgeDirectory: string,
  refresh = false,
): Promise<string> {
  if (source.kind === "github") {
    return cacheGitHubSource(source, bridgeDirectory, refresh);
  }

  if (!await isDirectory(source.directory)) {
    throw new Error(`Local theme directory does not exist: ${source.directory}`);
  }

  return source.directory;
}
