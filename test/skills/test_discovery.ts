import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSkillsFromDir, discoverSkills } from "../../server/workspace/skills/discovery.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function writeSkill(parent: string, name: string, description: string, body = ""): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const content = `---\ndescription: ${description}\n---\n\n${body}`;
  await writeFile(path, content);
  return dir;
}

describe("collectSkillsFromDir", () => {
  it("returns an empty list when the root does not exist", async () => {
    const skills = await collectSkillsFromDir(join(root, "does-not-exist"), "user");
    assert.deepEqual(skills, []);
  });

  it("returns an empty list when the root is empty", async () => {
    const skills = await collectSkillsFromDir(root, "user");
    assert.deepEqual(skills, []);
  });

  it("reads a single skill with frontmatter + body", async () => {
    await writeSkill(root, "ci_enable", "Enable CI", "## Steps\n1. Do it");
    const skills = await collectSkillsFromDir(root, "user");
    assert.equal(skills.length, 1);
    const [skill] = skills;
    assert.ok(skill);
    assert.equal(skill.name, "ci_enable");
    assert.equal(skill.description, "Enable CI");
    assert.equal(skill.source, "user");
    assert.match(skill.body, /## Steps/);
    // Path uses `/` on POSIX and `\` on Windows; accept either.
    assert.match(skill.path, /[\\/]ci_enable[\\/]SKILL\.md$/);
  });

  it("skips directories without a SKILL.md", async () => {
    await mkdir(join(root, "not-a-skill"), { recursive: true });
    await writeFile(join(root, "not-a-skill", "readme.md"), "hello");
    await writeSkill(root, "real_skill", "Real one");
    const skills = await collectSkillsFromDir(root, "user");
    assert.equal(skills.length, 1);
    const [skill] = skills;
    assert.ok(skill);
    assert.equal(skill.name, "real_skill");
  });

  it("skips hidden entries (.DS_Store, .gitkeep)", async () => {
    await writeFile(join(root, ".DS_Store"), "junk");
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeSkill(root, "visible", "Visible");
    const skills = await collectSkillsFromDir(root, "user");
    assert.equal(skills.length, 1);
    const [skill] = skills;
    assert.ok(skill);
    assert.equal(skill.name, "visible");
  });

  it("skips entries where SKILL.md has no frontmatter", async () => {
    const dir = join(root, "broken");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "# No frontmatter here\n");
    await writeSkill(root, "ok", "Fine");
    const skills = await collectSkillsFromDir(root, "user");
    assert.equal(skills.length, 1);
    const [skill] = skills;
    assert.ok(skill);
    assert.equal(skill.name, "ok");
  });

  it("follows a symlinked skill directory", async () => {
    const target = mkdtempSync(join(tmpdir(), "skills-target-"));
    try {
      await writeSkill(target, "linked-inner", "From target");
      // Create a symlink at root/linked -> target/linked-inner
      await symlink(join(target, "linked-inner"), join(root, "linked"));
      const skills = await collectSkillsFromDir(root, "user");
      assert.equal(skills.length, 1);
      const [skill] = skills;
      assert.ok(skill);
      assert.equal(skill.name, "linked");
      assert.equal(skill.description, "From target");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("returns results sorted alphabetically", async () => {
    await writeSkill(root, "zebra", "Z");
    await writeSkill(root, "apple", "A");
    await writeSkill(root, "mango", "M");
    const skills = await collectSkillsFromDir(root, "user");
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["apple", "mango", "zebra"],
    );
  });

  it("tags results with the given source", async () => {
    await writeSkill(root, "a", "A");
    const [userSkill] = await collectSkillsFromDir(root, "user");
    const [projectSkill] = await collectSkillsFromDir(root, "project");
    assert.ok(userSkill);
    assert.ok(projectSkill);
    assert.equal(userSkill.source, "user");
    assert.equal(projectSkill.source, "project");
  });

  it("gracefully handles an unreadable SKILL.md", async (ctx) => {
    if (process.platform === "win32") {
      // Windows does not honour POSIX-style chmod(0o000); the CI
      // runner reads the file anyway and the test would fail.
      ctx.skip("Windows does not honour chmod(0o000)");
      return;
    }
    if (process.getuid && process.getuid() === 0) {
      // Some CI sandboxes run as root which also bypasses chmod.
      ctx.skip("root bypasses chmod, cannot enforce unreadable permissions");
      return;
    }
    const dir = join(root, "locked");
    await mkdir(dir);
    const path = join(dir, "SKILL.md");
    await writeFile(path, "---\ndescription: X\n---\nbody");
    await chmod(path, 0o000);
    try {
      const skills = await collectSkillsFromDir(root, "user");
      assert.deepEqual(skills, []);
    } finally {
      await chmod(path, 0o644).catch(() => {});
    }
  });
});

describe("discoverSkills", () => {
  it("returns an empty list when user and project dirs are both missing", async () => {
    const skills = await discoverSkills({
      userDir: join(root, "nope"),
      workspaceRoot: root,
    });
    assert.deepEqual(skills, []);
  });

  it("returns only user skills when no workspaceRoot is given", async () => {
    await writeSkill(root, "u1", "User 1");
    await writeSkill(root, "u2", "User 2");
    const skills = await discoverSkills({ userDir: root });
    assert.equal(skills.length, 2);
    assert.deepEqual(
      skills.map((skill) => [skill.name, skill.source]),
      [
        ["u1", "user"],
        ["u2", "user"],
      ],
    );
  });

  it("merges user + project skills, project wins on name collision", async () => {
    const userRoot = root;
    const workspace = mkdtempSync(join(tmpdir(), "skills-ws-"));
    try {
      const projectRoot = join(workspace, ".claude", "skills");
      await mkdir(projectRoot, { recursive: true });
      await writeSkill(userRoot, "only_user", "User only");
      await writeSkill(userRoot, "shared", "From user");
      await writeSkill(projectRoot, "shared", "From project");
      await writeSkill(projectRoot, "only_project", "Project only");

      const skills = await discoverSkills({
        userDir: userRoot,
        workspaceRoot: workspace,
      });
      // Alphabetical: only_project, only_user, shared
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.source, skill.description]),
        [
          ["only_project", "project", "Project only"],
          ["only_user", "user", "User only"],
          ["shared", "project", "From project"],
        ],
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
