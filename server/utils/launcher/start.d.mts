// Type declarations for start.mjs.

export function launcherLogPath(home?: string): string;

export function detectLocale(options?: { env?: Record<string, string | undefined>; run?: () => string }): string;

export interface StartLauncherOptions {
  env?: Record<string, string | undefined>;
  tmpDir?: string;
  localeRunner?: () => string;
}

export type StartLauncherOutcome = "opened-existing" | "preflight-failed" | "starting" | "no-port";

export function startLauncher(options?: StartLauncherOptions): Promise<StartLauncherOutcome>;
