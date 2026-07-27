// Type declarations for preflight.mjs.

export interface NodeVersionRequirement {
  major: number;
  minor: number;
}

export const REQUIRED_NODE: NodeVersionRequirement;

export function parseNodeVersion(raw: string): NodeVersionRequirement | null;

export function isNodeVersionSupported(raw: string, required?: NodeVersionRequirement): boolean;

export function formatRequiredNode(required?: NodeVersionRequirement): string;

export interface CommandProbeOptions {
  env?: Record<string, string | undefined>;
  run?: (file: string, args: string[], options: object) => unknown;
}

export function isCommandAvailable(command: string, deps?: CommandProbeOptions): boolean;

export interface PreflightFailure {
  key: "nodeTooOld" | "npxMissing" | "claudeMissing";
  values: Record<string, string>;
}

export interface PreflightOptions {
  nodeVersion?: string;
  env?: Record<string, string | undefined>;
  commandAvailable?: (command: string) => boolean;
}

export function runPreflight(deps?: PreflightOptions): PreflightFailure | null;
