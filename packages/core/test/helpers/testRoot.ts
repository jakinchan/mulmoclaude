import path from "node:path";

// A notional workspace root, in the shape `canonicalRoot` produces ON THIS
// PLATFORM.
//
// `canonicalRoot` is `path.resolve`, so a POSIX literal is not a fixed point of
// it everywhere: on Windows `path.resolve("/work/proj")` is `C:\work\proj`
// (the CWD's drive), never `/work/proj`. A test that hardcodes the POSIX
// spelling therefore asserts against a root the code cannot produce there, and
// only Windows sees it — `lint_test_windows` runs on a schedule and on push to
// main, so it lands after the merge (#2864).
export const testRoot = (...segments: string[]): string => path.resolve("/", ...segments);
