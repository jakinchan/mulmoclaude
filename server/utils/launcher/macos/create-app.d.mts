// Type declarations for macos/create-app.mjs.

export const BUNDLE_IDENTIFIER: string;

export interface InfoPlistOptions {
  name: string;
  version: string;
  identifier?: string;
}

export function renderInfoPlist(options: InfoPlistOptions): string;

export function writeBundleMessages(resourcesDir: string): void;

export interface CreateAppBundleOptions {
  bundlePath: string;
  name: string;
  version: string;
}

export interface CreatedAppBundle {
  bundlePath: string;
  iconWritten: boolean;
}

export function createAppBundle(options: CreateAppBundleOptions): Promise<CreatedAppBundle>;
