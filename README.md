# Astro Theme Bridge

`astro-theme-bridge` produces a working Astro project by copying a theme source into `.astro-theme-bridge/merged`, then overlaying files from the current directory.

## Install and use

```sh
pnpm install
pnpm build
pnpm link --global

astro-theme-bridge init
astro-theme-bridge build
astro-theme-bridge run dev -- --host
astro-theme-bridge dev dev -- --host
```

`init` asks for a source and writes this project configuration:

```yaml
theme: github:owner/repository@v1.0.0
```

Use `local:path/to/theme` for a local theme. Local paths are resolved from the project directory. `source` is accepted as an alias of `theme`.

GitHub themes are cached at `.astro-theme-bridge/github-repo`. `update` discards that cache and clones the configured source again. `build --clean` also removes `merged/node_modules`; a normal build preserves it.

Before `run` or `dev` starts a script, the bridge compares the SHA-256 of merged `package.json` with `.astro-theme-bridge/package-json.sha256`. On the first run or after a change, it installs dependencies using the merged project's package manager, then records the hash. `dev` updates only the changed merged file in place, preserving its path for Astro's file watcher. Changes to bridge configuration files or directory structure trigger a full rebuild because they can affect multiple paths.

## Overlay rules

`astro-theme-bridge.yaml` sets root rules. A `.astro-theme-bridge.yaml` in any directory sets rules for that directory and its descendants. Child rule values replace the corresponding parent rule. Paths are evaluated relative to the rule file that declared them.

```yaml
theme: github:owner/repository@main
include:
  - src/**
  - public/**
exclude: src/drafts/**
merge:
  - package.json
  - src/content/config.yaml
remove:
  - src/legacy/**
```

Rules use gitignore-style patterns. The tool applies `remove` after copying the theme and before overlaying local files, then applies `include`, `exclude`, and `merge`. `remove` only deletes files copied from the theme, so a same-path local file is still written afterwards. With no `include`, all non-hidden files are included. With no `merge`, JSON and YAML files merge by default. Configuration files, `.astro-theme-bridge`, `.git`, and `node_modules` are never overlaid.

For structured files, plain values overwrite, object keys recursively merge, `^key` overwrites a complete object key, `~key` deletes a key, `+key` prepends to an array, and `key+` appends to an array. The value of `~key` is ignored, including when the key does not exist in the theme file.
