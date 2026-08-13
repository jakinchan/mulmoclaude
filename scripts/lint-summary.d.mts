// Hand-written types for lint-summary.mjs, the way scripts/dev-server.d.mts
// types its own script — the file stays plain JS so eslint can load it as a
// formatter dependency without a build step.
export interface EslintMessage {
  ruleId: string | null;
  severity: number;
}

export interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

export function parseEslintJson(text: string): EslintResult[];
export function renderReport(results: EslintResult[], cwd?: string): string;
