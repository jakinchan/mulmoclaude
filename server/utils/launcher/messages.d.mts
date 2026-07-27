// Type declarations for messages.mjs. See the .mjs file for why the
// icon launcher carries its own catalog instead of reusing src/lang/.

export interface LauncherFailureMessage {
  title: string;
  body: string;
  action: string;
}

export interface LauncherMessages {
  starting: { title: string; detail: string; firstRun: string };
  nodeMissing: LauncherFailureMessage & { hint: string };
  nodeTooOld: LauncherFailureMessage;
  npxMissing: LauncherFailureMessage;
  claudeMissing: LauncherFailureMessage & { steps: string[]; stepsNote: string };
  startFailed: LauncherFailureMessage;
  noPort: LauncherFailureMessage;
  log: { label: string; reveal: string };
  retry: string;
}

export const LAUNCHER_LOCALES: string[];

export function pickLauncherLocale(rawLocale: string | undefined | null): string;

export function launcherMessages(locale: string): LauncherMessages;

export function fillPlaceholders(template: string, values: Record<string, string | number>): string;
