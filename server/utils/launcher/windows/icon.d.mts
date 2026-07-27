// Type declarations for windows/icon.mjs.

export function packIco(images: { size: number; png: Buffer }[]): Buffer;

export function buildIco(targetPath: string): Promise<boolean>;
