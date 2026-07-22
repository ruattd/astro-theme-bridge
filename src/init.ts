import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = "astro-theme-bridge.yaml";
const DEFAULT_GITIGNORE_LINES = [
  "node_modules/",
  ".astro/",
  "dist/",
  ".astro-theme-bridge/",
  "*.log",
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function askForSource(): Promise<string> {
  if (!input.isTTY) {
    throw new Error("init needs an interactive terminal, or pass --source.");
  }

  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question("Theme source [local:../astro-theme]: ");
    return answer.trim() || "local:../astro-theme";
  } finally {
    prompt.close();
  }
}

async function updateGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const current = await exists(gitignorePath) ? await readFile(gitignorePath, "utf8") : "";
  const knownLines = new Set(current.split(/\r?\n/));
  const missingLines = DEFAULT_GITIGNORE_LINES.filter((line) => !knownLines.has(line));

  if (missingLines.length === 0) {
    return;
  }

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${current}${prefix}${missingLines.join("\n")}\n`, "utf8");
}

export interface InitOptions {
  source?: string;
  force?: boolean;
}

export async function initializeProject(projectDirectory: string, options: InitOptions): Promise<void> {
  const projectRoot = path.resolve(projectDirectory);
  const configPath = path.join(projectRoot, CONFIG_FILE);

  if (!options.force && await exists(configPath)) {
    throw new Error(`${CONFIG_FILE} already exists. Use --force to replace it.`);
  }

  const source = options.source?.trim() || await askForSource();
  await writeFile(
    configPath,
    `# Theme source: github:owner/repository@ref or local:path\ntheme: ${source}\n`,
    "utf8",
  );
  await updateGitignore(projectRoot);
}
