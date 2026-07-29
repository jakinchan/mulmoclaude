import type { FileOps } from "gui-chat-protocol";
import { isHtmlArtifactPath, isPresentableHtmlPath, toArtifactsRelative } from "./paths";
import type { HtmlDispatchArgs } from "./contract";

/** Capabilities the dispatch router needs: the generic, shared
 *  `files.artifacts` FileOps, plus — for hosts that let presentHtml open pages
 *  outside `artifacts/html/` — `files.byPath` (see `HtmlExecuteContext`). The
 *  host wrapper additionally publishes a file-change event after `saveHtml`
 *  (host pubsub infra), which is layered on top of this pure read/write. */
export interface HtmlDispatchContext {
  files: { artifacts: FileOps; byPath?: FileOps };
}

/**
 * Server-side router for the View's `useRuntime().dispatch({ kind, … })` calls.
 * `loadHtml` returns the page's current bytes (source editor / print);
 * `saveHtml` overwrites it in place. Both validate containment with the same
 * `isHtmlArtifactPath` guard as the tool-call path before touching FileOps.
 * Throws on an invalid path / missing file — the host's dispatch route maps a
 * throw to a non-2xx, which the View's `dispatch` rejects on.
 */
export async function executeHtmlDispatch(context: HtmlDispatchContext, args: HtmlDispatchArgs): Promise<{ html: string } | { path: string }> {
  // `args` is cast from `unknown` in host dispatch wiring, so validate at
  // runtime before touching FileOps — a malformed payload must surface as a
  // clean error, not a TypeError / a write of a non-string body.
  if (typeof args?.path !== "string") {
    throw new Error("path must be an existing .html file");
  }
  // Same routing as the tool-call path: an artifact goes through
  // `files.artifacts`, anything else needs the host's `files.byPath`.
  const artifact = isHtmlArtifactPath(args.path);
  const files = artifact ? context.files.artifacts : context.files.byPath;
  if (!files || (!artifact && !isPresentableHtmlPath(args.path))) {
    throw new Error("path must be an existing .html file");
  }
  const rel = artifact ? toArtifactsRelative(args.path) : args.path;
  switch (args.kind) {
    case "loadHtml": {
      const html = await files.read(rel);
      return { html };
    }
    case "saveHtml": {
      if (typeof args.html !== "string") {
        throw new Error("saveHtml requires `html` as a string");
      }
      await files.write(rel, args.html);
      return { path: args.path };
    }
    default: {
      // Exhaustiveness guard: a new kind without a branch trips this at compile time.
      const exhaustive: never = args;
      throw new Error(`html plugin: unknown dispatch kind ${JSON.stringify(exhaustive)}`);
    }
  }
}
