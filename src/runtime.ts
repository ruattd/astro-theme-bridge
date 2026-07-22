import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import chokidar from "chokidar";

import { bridgePaths, buildProject, syncProjectFile } from "./build.js";

interface PackageManifest {
  packageManager?: string;
  scripts?: Record<string, string>;
}

interface PackageCommand {
  command: string;
  arguments: string[];
}

const PACKAGE_HASH_FILE = "package-json.sha256";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadPackageManifest(mergedDirectory: string): Promise<PackageManifest> {
  const packagePath = path.join(mergedDirectory, "package.json");
  let contents: string;
  try {
    contents = await readFile(packagePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Merged theme has no package.json at ${packagePath}.`);
    }

    throw new Error(`Could not parse ${packagePath}: ${(error as Error).message}`);
  }

  try {
    return JSON.parse(contents) as PackageManifest;
  } catch (error) {
    throw new Error(`Could not parse ${packagePath}: ${(error as Error).message}`);
  }
}

async function packageManagerFor(mergedDirectory: string, manifest: PackageManifest): Promise<string> {
  const configured = manifest.packageManager?.split("@")[0];
  if (configured && ["pnpm", "npm", "yarn", "bun"].includes(configured)) {
    return configured;
  }

  if (await fileExists(path.join(mergedDirectory, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await fileExists(path.join(mergedDirectory, "yarn.lock"))) {
    return "yarn";
  }
  if (await fileExists(path.join(mergedDirectory, "bun.lock")) || await fileExists(path.join(mergedDirectory, "bun.lockb"))) {
    return "bun";
  }
  if (await fileExists(path.join(mergedDirectory, "package-lock.json"))) {
    return "npm";
  }

  return "pnpm";
}

async function packageCommand(mergedDirectory: string, scriptAndArgs: string[]): Promise<PackageCommand> {
  const [script, ...rawArguments] = scriptAndArgs;
  if (!script) {
    throw new Error("Provide a package script to run.");
  }

  const manifest = await loadPackageManifest(mergedDirectory);
  if (!manifest.scripts?.[script]) {
    throw new Error(`The merged package.json does not define a \`${script}\` script.`);
  }

  const packageManager = await packageManagerFor(mergedDirectory, manifest);
  const argumentsForScript = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  return {
    command: packageManager,
    arguments: ["run", script, ...(argumentsForScript.length > 0 ? ["--", ...argumentsForScript] : [])],
  };
}

async function savedPackageHash(hashPath: string): Promise<string | undefined> {
  try {
    return (await readFile(hashPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function ensureMergedDependencies(mergedDirectory: string): Promise<boolean> {
  const packagePath = path.join(mergedDirectory, "package.json");
  const packageContents = await readFile(packagePath, "utf8");
  const packageHash = createHash("sha256").update(packageContents).digest("hex");
  const hashPath = path.join(path.dirname(mergedDirectory), PACKAGE_HASH_FILE);

  if (packageHash === await savedPackageHash(hashPath)) {
    return false;
  }

  const manifest = await loadPackageManifest(mergedDirectory);
  const packageManager = await packageManagerFor(mergedDirectory, manifest);
  const child = spawn(packageManager, ["install"], {
    cwd: mergedDirectory,
    env: { ...process.env, CI: "true" },
    stdio: "inherit",
  });
  const exitCode = await waitForChild(child);
  if (exitCode !== 0) {
    throw new Error(`Dependency installation failed with exit code ${exitCode}.`);
  }

  await writeFile(hashPath, `${packageHash}\n`, "utf8");
  return true;
}

export async function startPackageScript(
  mergedDirectory: string,
  scriptAndArgs: string[],
  detached = false,
): Promise<ChildProcess> {
  const command = await packageCommand(mergedDirectory, scriptAndArgs);
  return spawn(command.command, command.arguments, {
    cwd: mergedDirectory,
    stdio: "inherit",
    detached,
  });
}

export function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }

      resolve(signal === "SIGINT" ? 130 : 1);
    });
  });
}

function forwardSignalToChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
  }

  child.kill(signal);
}

async function waitForChildWithInterrupt(child: ChildProcess): Promise<number> {
  let interruptForwarded = false;
  const forwardInterrupt = (): void => {
    if (!interruptForwarded && child.exitCode === null) {
      interruptForwarded = true;
      forwardSignalToChildGroup(child, "SIGINT");
    }
  };

  process.on("SIGINT", forwardInterrupt);
  try {
    return await waitForChild(child);
  } finally {
    process.off("SIGINT", forwardInterrupt);
  }
}

export async function runProjectScript(projectDirectory: string, scriptAndArgs: string[]): Promise<number> {
  const result = await buildProject(projectDirectory);
  await ensureMergedDependencies(result.mergedDirectory);
  const child = await startPackageScript(
    result.mergedDirectory,
    scriptAndArgs,
    process.platform !== "win32",
  );
  return waitForChildWithInterrupt(child);
}

function shouldIgnoreWatchPath(projectRoot: string, candidate: string): boolean {
  const relativePath = path.relative(projectRoot, candidate);
  if (relativePath === "") {
    return false;
  }

  return relativePath.split(path.sep).some((segment) =>
    segment === ".astro-theme-bridge" || segment === ".git" || segment === "node_modules",
  );
}

function needsFullRebuild(event: string, candidate: string): boolean {
  if (event === "addDir" || event === "unlinkDir") {
    return true;
  }

  const name = path.basename(candidate);
  return name === "astro-theme-bridge.yaml" || name === ".astro-theme-bridge.yaml";
}

export async function developProject(projectDirectory: string, scriptAndArgs: string[]): Promise<number> {
  const projectRoot = path.resolve(projectDirectory);
  const initialBuild = await buildProject(projectRoot);
  await ensureMergedDependencies(initialBuild.mergedDirectory);
  const child = await startPackageScript(
    initialBuild.mergedDirectory,
    scriptAndArgs,
    process.platform !== "win32",
  );
  const { mergedDirectory } = bridgePaths(projectRoot);
  let timer: NodeJS.Timeout | undefined;
  let updating = false;
  let updateQueued = false;
  let fullRebuildQueued = false;
  let childHasExited = false;
  const changedPaths = new Map<string, string>();

  const updateMergedFiles = async (): Promise<void> => {
    if (updating) {
      updateQueued = true;
      return;
    }

    updating = true;
    try {
      do {
        updateQueued = false;
        if (fullRebuildQueued) {
          fullRebuildQueued = false;
          changedPaths.clear();
          await buildProject(projectRoot);
          process.stdout.write(`Updated ${mergedDirectory}\n`);
          continue;
        }

        const paths = [...changedPaths.keys()];
        changedPaths.clear();
        for (const relativePath of paths) {
          if (childHasExited) {
            break;
          }

          await syncProjectFile(projectRoot, relativePath);
          process.stdout.write(`Updated ${path.join(mergedDirectory, relativePath)}\n`);
        }
      } while (updateQueued && !childHasExited);
    } catch (error) {
      process.stderr.write(`Unable to update merged files: ${(error as Error).message}\n`);
    } finally {
      updating = false;
    }
  };

  const queueUpdate = (event: string, candidate: string): void => {
    if (childHasExited) {
      return;
    }

    if (needsFullRebuild(event, candidate)) {
      fullRebuildQueued = true;
      changedPaths.clear();
    } else {
      const relativePath = path.relative(projectRoot, candidate);
      if (relativePath !== "" && !relativePath.startsWith(`..${path.sep}`) && relativePath !== "..") {
        changedPaths.set(relativePath, event);
      }
    }

    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void updateMergedFiles();
    }, 100);
  };

  const watcher = chokidar.watch(projectRoot, {
    ignoreInitial: true,
    ignored: (candidate) => shouldIgnoreWatchPath(projectRoot, candidate),
  });
  watcher.on("all", queueUpdate);

  try {
    return await waitForChildWithInterrupt(child);
  } finally {
    childHasExited = true;
    if (timer) {
      clearTimeout(timer);
    }
    await watcher.close();
  }
}
