// Type declarations for platform.mjs.

export function browserOpenArgv(target: string, platform: string): { command: string; args: string[] };

export function npxCommand(platform: string): string;
