// Type declarations for detect-server.mjs.

import type { get as httpGet } from "node:http";

export type ServerPresence = "mulmoclaude" | "foreign" | "absent";

export const HEALTH_PATH: string;

export const SERVER_PRESENCE: Record<ServerPresence, ServerPresence>;

export interface HealthProbeOutcome {
  status?: number;
  body?: string;
  errorCode?: string;
}

export function classifyHealthProbe(outcome: HealthProbeOutcome): ServerPresence;

export function detectRunningServer(port: number, deps?: { get?: typeof httpGet }): Promise<ServerPresence>;

export interface FindRunningServerOptions {
  probeCount?: number;
  probe?: (port: number) => Promise<ServerPresence>;
}

export function findRunningServerPort(startPort: number, deps?: FindRunningServerOptions): Promise<number | null>;
