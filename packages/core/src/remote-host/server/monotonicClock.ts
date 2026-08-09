// The clock the runner measures its OWN elapsed time with (#2845).
//
// `Date.now()` is the wall clock, and the wall clock moves for reasons that have
// nothing to do with this process: an NTP step, a manual change, a VM syncing its
// time after a suspend. A runner that measures "how long have we been failing"
// against it reads those jumps as an outage — and one report arrived as
// "no presence write acknowledged for 459s" from a host whose network was fine.
//
// Server-side only, which is where every caller lives.
import { performance } from "node:perf_hooks";

/** Milliseconds from an arbitrary origin, never moving backwards. Only differences
 *  between two readings mean anything — never compare one to a wall-clock time. */
export const monotonicNowMs = (): number => performance.now();
