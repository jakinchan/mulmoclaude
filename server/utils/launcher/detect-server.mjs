// "Is MulmoClaude already running on this port?"
//
// The icon launcher must never start a second server: clicking the icon
// while the app is open should just bring up the browser. A free/busy
// port probe is not enough — a busy port could be anything — so this
// asks `/api/health` and reads the answer.
//
// `/api/health` sits behind `bearerAuth` (server/index.ts), so an
// unauthenticated probe gets 401, not the `{status:"OK"}` body. That 401
// IS the signal: it is a MulmoClaude-shaped refusal, and it separates
// cleanly from a connection refusal (nobody there) and from another
// app's 404. Do not "fix" the 401 by exempting the route from auth.

import { get as httpGet } from "node:http";

export const HEALTH_PATH = "/api/health";

// A loopback request that hasn't answered in this long is not going to.
const PROBE_TIMEOUT_MS = 2000;

export const SERVER_PRESENCE = {
  mulmoclaude: "mulmoclaude",
  foreign: "foreign",
  absent: "absent",
};

/**
 * Turn a raw probe outcome into a decision. Pure.
 * @param {{ status?: number, body?: string, errorCode?: string }} outcome
 * @returns {"mulmoclaude" | "foreign" | "absent"}
 */
export function classifyHealthProbe({ status, body, errorCode }) {
  if (errorCode !== undefined) return SERVER_PRESENCE.absent;
  if (status === 401) return SERVER_PRESENCE.mulmoclaude;
  if (status === 200 && looksLikeHealthBody(body)) return SERVER_PRESENCE.mulmoclaude;
  return SERVER_PRESENCE.foreign;
}

// Auth can be bypassed in some run modes, in which case the real health
// body comes back. Match on its shape rather than trusting a bare 200,
// which any web server on the port would also return.
function looksLikeHealthBody(body) {
  if (typeof body !== "string") return false;
  try {
    return JSON.parse(body).status === "OK";
  } catch {
    return false;
  }
}

/**
 * Probe `127.0.0.1:<port>/api/health` and classify what answered.
 * Never rejects — a launcher that throws while checking has no way to
 * tell the user anything.
 * @param {number} port
 * @param {{ get?: typeof httpGet }} [deps]
 * @returns {Promise<"mulmoclaude" | "foreign" | "absent">}
 */
export function detectRunningServer(port, { get = httpGet } = {}) {
  return new Promise((resolve) => {
    const request = get({ host: "127.0.0.1", port, path: HEALTH_PATH, timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.setEncoding("utf8");
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(classifyHealthProbe({ status: res.statusCode, body: chunks.join("") })));
    });
    request.on("error", (error) => resolve(classifyHealthProbe({ errorCode: error.code ?? "UNKNOWN" })));
    request.on("timeout", () => {
      request.destroy();
      resolve(classifyHealthProbe({ errorCode: "ETIMEDOUT" }));
    });
  });
}
