// Type declarations for windows/create-launcher.mjs.

export const SHORTCUT_FILE_NAME: string;

export function writeWindowsMessages(rootDir: string): void;

export interface ShortcutPowerShellOptions {
  shortcutPath: string;
  stubPath: string;
  iconPath: string | null;
  workingDir: string;
}

export function shortcutPowerShell(options: ShortcutPowerShellOptions): string;

export function createWindowsShortcut(options: { rootDir: string; shortcutPath: string }): Promise<{ shortcutPath: string; iconWritten: boolean }>;
