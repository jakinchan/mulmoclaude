// Type declarations for launcher-page.mjs.

import type { LauncherMessages } from "./messages.d.mts";

export function escapeHtml(value: string): string;

export function linkify(text: string): string;

export function giveUpAfterSeconds(): number;

export interface LauncherPageOptions {
  messages: LauncherMessages;
  port: number;
  logPath: string;
  locale: string;
}

export function renderLauncherPage(options: LauncherPageOptions): string;

export interface LauncherPageFailure {
  title: string;
  body: string;
  action: string;
  steps?: string[];
  stepsNote?: string;
  hint?: string;
}

export interface ErrorPageOptions {
  messages: LauncherMessages;
  failure: LauncherPageFailure;
  logPath: string;
  locale: string;
}

export function renderErrorPage(options: ErrorPageOptions): string;
