import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProject, syncProjectFile } from "../src/build.js";
import { mergeStructured } from "../src/merge.js";
import { runProjectScript } from "../src/runtime.js";
import { parseThemeSource } from "../src/source.js";

test("merges objects, override and delete keys, and array insertion keys", () => {
  const result = mergeStructured(
    {
      title: "Theme",
      items: ["theme"],
      settings: { color: "blue", nested: { one: true } },
      removable: true,
    },
    {
      title: "Project",
      "+items": ["first"],
      "items+": ["last"],
      settings: { nested: { two: true } },
      "^settings": { color: "red" },
      "~removable": null,
      "~not-present": "ignored",
    },
  );

  assert.deepEqual(result, {
    title: "Project",
    items: ["first", "theme", "last"],
    settings: { color: "red" },
  });
});

test("parses supported source definitions", () => {
  assert.deepEqual(parseThemeSource("github:ruattd/astro-theme@v1.0.0", "/project"), {
    kind: "github",
    owner: "ruattd",
    repository: "astro-theme",
    ref: "v1.0.0",
    raw: "github:ruattd/astro-theme@v1.0.0",
  });
  assert.deepEqual(parseThemeSource("local:theme", "/project"), {
    kind: "local",
    directory: "/project/theme",
    raw: "local:theme",
  });
});

test("builds a local theme and applies default structured merging", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "astro-theme-bridge-"));
  const projectDirectory = path.join(temporaryDirectory, "project");
  const themeDirectory = path.join(temporaryDirectory, "theme");

  try {
    await Promise.all([mkdir(projectDirectory), mkdir(themeDirectory)]);
    await Promise.all([
      writeFile(
        path.join(themeDirectory, "content.json"),
        `${JSON.stringify({ title: "Theme", items: ["theme"], settings: { color: "blue" } })}\n`,
      ),
      writeFile(path.join(themeDirectory, ".hidden.json"), "{\"value\": \"theme\"}\n"),
      writeFile(path.join(projectDirectory, ".hidden.json"), "{\"value\": \"project\"}\n"),
      writeFile(
        path.join(projectDirectory, "astro-theme-bridge.yaml"),
        `theme: local:${themeDirectory}\n`,
      ),
      writeFile(
        path.join(projectDirectory, "content.json"),
        `${JSON.stringify({ title: "Project", "+items": ["first"], "items+": ["last"] })}\n`,
      ),
    ]);

    const result = await buildProject(projectDirectory);
    const mergedContent = JSON.parse(await readFile(path.join(result.mergedDirectory, "content.json"), "utf8"));
    const mergedHidden = await readFile(path.join(result.mergedDirectory, ".hidden.json"), "utf8");

    assert.equal(result.mergedFiles, 1);
    assert.deepEqual(mergedContent, {
      title: "Project",
      items: ["first", "theme", "last"],
      settings: { color: "blue" },
    });
    assert.equal(mergedHidden, "{\"value\": \"theme\"}\n");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("removes theme files using inherited directory rules before applying local files", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "astro-theme-bridge-"));
  const projectDirectory = path.join(temporaryDirectory, "project");
  const themeDirectory = path.join(temporaryDirectory, "theme");

  try {
    await Promise.all([
      mkdir(path.join(projectDirectory, "src"), { recursive: true }),
      mkdir(path.join(themeDirectory, "src"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(themeDirectory, "src", "obsolete.ts"), "export const obsolete = true;\n"),
      writeFile(path.join(themeDirectory, "src", "replacement.ts"), "export const theme = true;\n"),
      writeFile(path.join(themeDirectory, "src", "keep.ts"), "export const keep = true;\n"),
      writeFile(path.join(projectDirectory, "astro-theme-bridge.yaml"), `theme: local:${themeDirectory}\n`),
      writeFile(path.join(projectDirectory, "src", ".astro-theme-bridge.yaml"), "remove:\n  - obsolete.ts\n  - replacement.ts\n"),
      writeFile(path.join(projectDirectory, "src", "replacement.ts"), "export const project = true;\n"),
    ]);

    const result = await buildProject(projectDirectory);
    const mergedSourceDirectory = path.join(result.mergedDirectory, "src");

    assert.equal(result.removedFiles, 2);
    await assert.rejects(readFile(path.join(mergedSourceDirectory, "obsolete.ts"), "utf8"));
    assert.equal(await readFile(path.join(mergedSourceDirectory, "replacement.ts"), "utf8"), "export const project = true;\n");
    assert.equal(await readFile(path.join(mergedSourceDirectory, "keep.ts"), "utf8"), "export const keep = true;\n");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("syncs only a changed file without replacing its merged target", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "astro-theme-bridge-"));
  const projectDirectory = path.join(temporaryDirectory, "project");
  const themeDirectory = path.join(temporaryDirectory, "theme");

  try {
    await Promise.all([mkdir(projectDirectory), mkdir(themeDirectory)]);
    await Promise.all([
      writeFile(path.join(themeDirectory, "changed.ts"), "export const value = 'theme';\n"),
      writeFile(path.join(themeDirectory, "unrelated.ts"), "export const untouched = 'theme';\n"),
      writeFile(path.join(projectDirectory, "astro-theme-bridge.yaml"), `theme: local:${themeDirectory}\n`),
      writeFile(path.join(projectDirectory, "changed.ts"), "export const value = 'first';\n"),
    ]);

    const result = await buildProject(projectDirectory);
    const changedTarget = path.join(result.mergedDirectory, "changed.ts");
    const unrelatedTarget = path.join(result.mergedDirectory, "unrelated.ts");
    const before = await lstat(changedTarget);
    await writeFile(unrelatedTarget, "preserve this running-file state\n");
    await writeFile(path.join(projectDirectory, "changed.ts"), "export const value = 'second';\n");

    await syncProjectFile(projectDirectory, "changed.ts");

    const after = await lstat(changedTarget);
    assert.equal(await readFile(changedTarget, "utf8"), "export const value = 'second';\n");
    assert.equal(await readFile(unrelatedTarget, "utf8"), "preserve this running-file state\n");
    if (process.platform !== "win32") {
      assert.equal(after.ino, before.ino);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("run forwards one SIGINT to the package script process group", { timeout: 10_000 }, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "astro-theme-bridge-"));
  const projectDirectory = path.join(temporaryDirectory, "project");
  const themeDirectory = path.join(temporaryDirectory, "theme");

  try {
    await Promise.all([mkdir(projectDirectory), mkdir(themeDirectory)]);
    await Promise.all([
      writeFile(
        path.join(themeDirectory, "package.json"),
        `${JSON.stringify({
          packageManager: "pnpm@10.0.0",
          scripts: { hold: "node -e \"setInterval(() => {}, 1000)\"" },
        })}\n`,
      ),
      writeFile(
        path.join(projectDirectory, "astro-theme-bridge.yaml"),
        `theme: local:${themeDirectory}\n`,
      ),
    ]);

    const running = runProjectScript(projectDirectory, ["hold"]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.kill(process.pid, "SIGINT");

    assert.equal(await running, 130);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
