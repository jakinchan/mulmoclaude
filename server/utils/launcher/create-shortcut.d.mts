// Type declarations for create-shortcut.mjs.

export const APP_NAME: string;

export function defaultInstallDir(deps?: { home?: string; canWrite?: (path: string) => boolean }): string;

export function parseCreateShortcutArgs(argv: string[]): { dir: string | null; assumeYes: boolean };

export interface CreateShortcutContext {
  version: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export function runCreateShortcut(argv: string[], context: CreateShortcutContext): Promise<number>;
