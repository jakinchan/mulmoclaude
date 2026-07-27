// Type declarations for windows/locale.mjs.

export function primaryLanguageId(lcid: number): number;

export function launcherLocaleForLcid(lcid: number): string;

export function windowsMessageFileTargets(): { primaryLanguageId: number; locale: string }[];
