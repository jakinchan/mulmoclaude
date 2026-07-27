// Type declarations for create-shortcut.mjs.

export const APP_NAME: string;

export function defaultInstallDir(deps?: { home?: string; canWrite?: (path: string) => boolean }): string;

export type CreateShortcutArgs = { ok: true; dir: string | null; assumeYes: boolean } | { ok: false; reason: string };

export function parseCreateShortcutArgs(argv: string[]): CreateShortcutArgs;

export function resolveBundlePath(dir: string | null): { installDir: string; bundlePath: string };

export function defaultShortcutDir(deps?: { env?: Record<string, string | undefined>; home?: string }): string;

export function windowsLauncherRoot(deps?: { env?: Record<string, string | undefined>; home?: string }): string;

export function resolveShortcutPath(dir: string | null): { installDir: string; shortcutPath: string; rootDir: string };

export interface CreateShortcutContext {
  version: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export function runCreateShortcut(argv: string[], context: CreateShortcutContext): Promise<number>;
