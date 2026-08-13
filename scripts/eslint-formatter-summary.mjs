import { appendFileSync } from "node:fs";
import { ESLint } from "eslint";
import { renderReport } from "./lint-summary.mjs";

/**
 * `stylish`, unchanged — plus the findings report, written to GitHub's job
 * summary on the way past.
 *
 * A formatter rather than a second `eslint` invocation: ESLint emits one format
 * per run, so the alternative was linting twice, once for the log and once for
 * JSON. This costs one run and no workflow edit, since the flag lives in the
 * `lint` script that CI already calls.
 *
 * Outside Actions `GITHUB_STEP_SUMMARY` is unset and this writes nothing, so a
 * terminal run behaves exactly as before. `yarn lint:summary` is how to see the
 * report locally.
 */
export default async function format(results, context) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      // ESLint's cwd, not the process's: the paths in `results` are absolute
      // and relative to that one, so a run started from anywhere else would
      // otherwise group every finding under `other`.
      appendFileSync(summaryPath, renderReport(results, context?.cwd));
    } catch (err) {
      // A summary that cannot be written must not fail the lint that produced
      // it — the findings below are the point, this is the garnish.
      process.stderr.write(`lint summary not written: ${err.message}\n`);
    }
  }
  const stylish = await new ESLint({ concurrency: 1 }).loadFormatter("stylish");
  return stylish.format(results, context);
}
