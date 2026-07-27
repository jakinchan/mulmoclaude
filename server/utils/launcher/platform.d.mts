// Type declarations for platform.mjs.

export function windowsLocalAppData(deps?: { home?: string; env?: Record<string, string | undefined> }): string;

export function launcherPaths(deps?: { home?: string; platform?: string; env?: Record<string, string | undefined> }): { logPath: string; pageDir: string };

export function fileUrl(path: string, platform?: string): string;

export function browserOpenArgv(target: string, platform: string): { command: string; args: string[] };

export function npxCommand(platform: string): string;
