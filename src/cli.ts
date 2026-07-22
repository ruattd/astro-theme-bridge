#!/usr/bin/env node

import { Command } from "commander";

import { buildProject, updateTheme } from "./build.js";
import { initializeProject } from "./init.js";
import { developProject, runProjectScript } from "./runtime.js";

const program = new Command()
  .name("astro-theme-bridge")
  .description("Overlay local Astro project files onto a reusable theme source.")
  .showHelpAfterError();

program
  .command("init")
  .description("Create an astro-theme-bridge.yaml configuration file")
  .option("--source <source>", "theme source, for example github:owner/repository@ref")
  .option("--force", "replace an existing configuration file")
  .action(async (options: { source?: string; force?: boolean }) => {
    await initializeProject(process.cwd(), options);
    process.stdout.write("Created astro-theme-bridge.yaml and updated .gitignore\n");
  });

program
  .command("build")
  .description("Build the merged theme directory")
  .option("--clean", "also remove merged node_modules before building")
  .action(async (options: { clean?: boolean }) => {
    const result = await buildProject(process.cwd(), options);
    process.stdout.write(
      `Built ${result.mergedDirectory} (${result.copiedFiles} copied, ${result.mergedFiles} merged, ${result.removedFiles} removed)\n`,
    );
  });

program
  .command("update")
  .description("Refresh the cached theme source")
  .action(async () => {
    await updateTheme(process.cwd());
    process.stdout.write("Theme source cache updated\n");
  });

program
  .command("run <script-and-args...>")
  .description("Build, then run a package script from the merged directory")
  .allowUnknownOption(true)
  .action(async (scriptAndArgs: string[]) => {
    process.exitCode = await runProjectScript(process.cwd(), scriptAndArgs);
  });

program
  .command("dev <script-and-args...>")
  .description("Build, watch local files, and run a package script")
  .allowUnknownOption(true)
  .action(async (scriptAndArgs: string[]) => {
    process.exitCode = await developProject(process.cwd(), scriptAndArgs);
  });

program.addHelpCommand("help [command]", "display help for a command");

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
