// #2842: the sandbox image freezes its Claude CLI at build time, and nothing
// used to say which one. These pin the reading of the labels that now record
// it — including the cases where the answer is "we don't know", which must not
// be reported as "too old".

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  IMAGE_INSPECT_FORMAT,
  MIN_CLAUDE_CODE_VERSION,
  SANDBOX_IMAGE_STALE_DAYS,
  isAtLeastVersion,
  parseSandboxImageInfo,
  sandboxImageWarnings,
} from "../../server/system/sandboxImageInfo.ts";
import { ONE_DAY_MS } from "../../server/utils/time.ts";

const NOW_MS = Date.parse("2026-08-14T00:00:00Z");
const daysAgo = (days: number): string => new Date(NOW_MS - days * ONE_DAY_MS).toISOString();

describe("isAtLeastVersion", () => {
  it("orders by major, then minor, then patch", () => {
    assert.equal(isAtLeastVersion("2.1.121", "2.1.121"), true);
    assert.equal(isAtLeastVersion("2.1.220", "2.1.121"), true);
    assert.equal(isAtLeastVersion("2.1.120", "2.1.121"), false);
    assert.equal(isAtLeastVersion("2.0.999", "2.1.121"), false);
    assert.equal(isAtLeastVersion("3.0.0", "2.1.121"), true);
  });

  // Patch numbers here run into the hundreds, which is exactly where a
  // string comparison silently inverts the answer ("2.1.99" > "2.1.121").
  it("compares patch numerically, not lexicographically", () => {
    assert.equal(isAtLeastVersion("2.1.99", "2.1.121"), false);
  });

  it("tolerates a prerelease suffix on the version", () => {
    assert.equal(isAtLeastVersion("2.1.121-beta.1", "2.1.121"), true);
  });

  it("returns null rather than a verdict when either side is unparsable", () => {
    assert.equal(isAtLeastVersion("latest", "2.1.121"), null);
    assert.equal(isAtLeastVersion("", "2.1.121"), null);
    assert.equal(isAtLeastVersion("2.1.121", "not-a-version"), null);
  });
});

describe("parseSandboxImageInfo", () => {
  it("reads the sha, the CLI version and the image age from one inspect line", () => {
    const info = parseSandboxImageInfo(`abc123|2.1.220|${daysAgo(3)}\n`, NOW_MS);
    assert.deepEqual(info, { dockerfileSha: "abc123", claudeCodeVersion: "2.1.220", ageDays: 3 });
  });

  // Go's `index` prints this when `.Config.Labels` is nil.
  it("treats `<no value>` as an unrecorded version", () => {
    const info = parseSandboxImageInfo(`abc123|<no value>|${daysAgo(1)}`, NOW_MS);
    assert.equal(info.claudeCodeVersion, null);
    assert.equal(info.dockerfileSha, "abc123");
  });

  // The shape real Docker actually produced for an unlabelled image (verified
  // against `docker image inspect alpine/git`): an EMPTY field, not
  // `<no value>`. Both reach us, so both are pinned — and an empty sha must
  // still read as "not ours", which is what makes `needsRebuild` rebuild it.
  it("treats empty label fields as unrecorded, the way docker emits them", () => {
    const info = parseSandboxImageInfo(`||${daysAgo(1)}`, NOW_MS);
    assert.deepEqual(info, { dockerfileSha: "", claudeCodeVersion: null, ageDays: 1 });
  });

  // A build that could not reach npm passes the literal `latest`, which names
  // no version — recording it as one would make the log lie.
  it("treats the literal `latest` as unrecorded", () => {
    assert.equal(parseSandboxImageInfo(`sha|latest|${daysAgo(1)}`, NOW_MS).claudeCodeVersion, null);
  });

  it("reports a null age instead of NaN when Created is missing or junk", () => {
    assert.equal(parseSandboxImageInfo("sha|2.1.220|", NOW_MS).ageDays, null);
    assert.equal(parseSandboxImageInfo("sha|2.1.220|not-a-date", NOW_MS).ageDays, null);
  });

  it("keeps the inspect template and the parser agreed on field order", () => {
    assert.equal(IMAGE_INSPECT_FORMAT.split("|").length, 3);
    assert.match(IMAGE_INSPECT_FORMAT, /\{\{\.Created\}\}$/);
  });
});

describe("sandboxImageWarnings", () => {
  it("says nothing about a current image", () => {
    assert.deepEqual(sandboxImageWarnings({ dockerfileSha: "s", claudeCodeVersion: "2.1.220", ageDays: 2 }), []);
  });

  it("warns when the CLI predates the version our MCP config depends on", () => {
    const warnings = sandboxImageWarnings({ dockerfileSha: "s", claudeCodeVersion: "2.1.100", ageDays: 1 });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.data.required, MIN_CLAUDE_CODE_VERSION);
  });

  it("warns once the image crosses the stale threshold", () => {
    assert.equal(sandboxImageWarnings({ dockerfileSha: "s", claudeCodeVersion: "2.1.220", ageDays: SANDBOX_IMAGE_STALE_DAYS - 1 }).length, 0);
    assert.equal(sandboxImageWarnings({ dockerfileSha: "s", claudeCodeVersion: "2.1.220", ageDays: SANDBOX_IMAGE_STALE_DAYS }).length, 1);
  });

  // "We could not record the version" must not be reported as "the version is
  // too old" — a warn that fires every boot for an unknowable reason is the
  // kind the reader learns to skip past, taking the real ones with it.
  it("does not cry wolf when the version was never recorded", () => {
    assert.deepEqual(sandboxImageWarnings({ dockerfileSha: "s", claudeCodeVersion: null, ageDays: 1 }), []);
  });

  it("reports both problems when an old image also carries an old CLI", () => {
    const warnings = sandboxImageWarnings({ dockerfileSha: "s", claudeCodeVersion: "2.0.1", ageDays: 400 });
    assert.equal(warnings.length, 2);
  });
});
