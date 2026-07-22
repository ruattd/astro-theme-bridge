export type RuleValue = string | string[];

export interface BridgeConfig {
  theme?: string;
  source?: string;
  include?: RuleValue;
  exclude?: RuleValue;
  merge?: RuleValue;
  remove?: RuleValue;
}

export interface RuleMatcher {
  baseDirectory: string;
  patterns: string[];
}

export interface FileRules {
  include?: RuleMatcher;
  exclude?: RuleMatcher;
  merge?: RuleMatcher;
  remove?: RuleMatcher;
}

export interface DirectoryRules {
  directory: string;
  rules: FileRules;
}

export interface OverlayFile {
  absolutePath: string;
  relativePath: string;
  rules: FileRules;
}

export interface LocalThemeSource {
  kind: "local";
  directory: string;
  raw: string;
}

export interface GitHubThemeSource {
  kind: "github";
  owner: string;
  repository: string;
  ref?: string;
  raw: string;
}

export type ThemeSource = LocalThemeSource | GitHubThemeSource;

export interface BuildOptions {
  clean?: boolean;
}

export interface BuildResult {
  mergedDirectory: string;
  copiedFiles: number;
  mergedFiles: number;
  removedFiles: number;
}
