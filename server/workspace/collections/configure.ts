// Wire @mulmoclaude/core/collection/server to MulmoClaude's workspace,
// logger, and path layout. Imported for side effect at the very top of
// server/index.ts so the binding is set before any collection storage
// operation runs. MulmoTerminal has its own equivalent shim.
import path from "node:path";
import { configureCollectionHost } from "@mulmoclaude/core/collection/server";
import { workspacePath } from "../workspace.js";
import { log } from "../../system/logger/index.js";
import { WORKSPACE_DIRS } from "../paths.js";
import { WORKSPACE_FILES } from "../../../src/config/workspacePaths.js";
import { USER_SKILLS_DIR, projectSkillsDir } from "../skills/paths.js";
import { feedsRoot } from "@mulmoclaude/core/feeds/paths";
import { isPresetSlug } from "../skills-preset.js";

configureCollectionHost({
  workspaceRoot: workspacePath,
  log,
  paths: {
    // One workspace, so every root has the same user scope — the merge
    // (user under project) is unchanged. A multi-root host answers `null`
    // for a project directory instead; see the contract in core's `host.ts`.
    userSkillsDir: () => USER_SKILLS_DIR,
    projectSkillsDir,
    feedsRoot,
    skillsStagingDir: (root) => path.join(root, WORKSPACE_DIRS.skillsStaging),
    archiveDir: WORKSPACE_DIRS.archive,
    collectionsRegistriesConfig: (root) => path.join(root, ...WORKSPACE_FILES.collectionsRegistries.split("/")),
  },
  isPresetSlug,
});
