// Tests for `server/utils/launcher/windows/create-launcher.mjs` and the
// Windows half of `create-shortcut.mjs`.
//
// A .lnk can only be written by Windows itself, so what is asserted here
// is everything decided BEFORE that call: the PowerShell source, the
// install locations, and the message files the .vbs stub reads. Each of
// these fails silently on a real machine — a shortcut with mangled
// arguments simply does nothing when double-clicked.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultShortcutDir, resolveShortcutPath, windowsLauncherRoot } from "../../../server/utils/launcher/create-shortcut.mjs";
import { renderNodeMissingText } from "../../../server/utils/launcher/node-missing-text.mjs";
import { shortcutPowerShell, writeWindowsMessages } from "../../../server/utils/launcher/windows/create-launcher.mjs";
import { launcherLocaleForLcid, windowsMessageFileTargets } from "../../../server/utils/launcher/windows/locale.mjs";

const withTempDir = (body: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-win-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("shortcutPowerShell", () => {
  const options = {
    shortcutPath: String.raw`C:\Users\a b\Start Menu\MulmoClaude.lnk`,
    stubPath: String.raw`C:\Users\a b\AppData\Local\MulmoClaude\utils\launcher\windows\launch.vbs`,
    iconPath: String.raw`C:\Users\a b\AppData\Local\MulmoClaude\icon.ico`,
    workingDir: String.raw`C:\Users\a b\AppData\Local\MulmoClaude`,
  };

  it("targets wscript.exe, which is what keeps the console window from appearing", () => {
    const script = shortcutPowerShell(options);
    assert.match(script, /\$link\.TargetPath = "\$env:SystemRoot\\System32\\wscript\.exe"/);
  });

  it("quotes the stub path inside the argument string", () => {
    // %LOCALAPPDATA% contains the account name, so a space is the normal
    // case, not the edge case: unquoted, wscript would receive a
    // truncated path and the shortcut would silently do nothing.
    const script = shortcutPowerShell(options);
    assert.ok(script.includes(`$link.Arguments = '"${options.stubPath}"'`), script);
  });

  it("escapes a single quote in a path rather than ending the PowerShell string", () => {
    const script = shortcutPowerShell({ ...options, workingDir: String.raw`C:\Users\O'Brien\App` });
    assert.ok(script.includes(String.raw`'C:\Users\O''Brien\App'`), script);
  });

  it("omits IconLocation when no icon was produced", () => {
    const withIcon = shortcutPowerShell(options);
    const without = shortcutPowerShell({ ...options, iconPath: null });
    assert.match(withIcon, /IconLocation/);
    assert.doesNotMatch(without, /IconLocation/);
    // `,0` selects the first icon in the file — omitting it leaves
    // Explorer guessing.
    assert.ok(withIcon.includes(`${options.iconPath},0`), withIcon);
  });

  it("stops on the first failure instead of reporting success", () => {
    assert.match(shortcutPowerShell(options), /\$ErrorActionPreference = 'Stop'/);
  });
});

describe("writeWindowsMessages", () => {
  it("names each file by primary language id, so the stub needs no LCID table", () => {
    withTempDir((dir) => {
      writeWindowsMessages(dir);
      const written = readdirSync(join(dir, "messages"));
      windowsMessageFileTargets().forEach(({ primaryLanguageId }) => {
        assert.ok(written.includes(`lcid-${primaryLanguageId}.txt`), `missing lcid-${primaryLanguageId}.txt`);
      });
      assert.ok(written.includes("en.txt"), "the stub falls back to en.txt for any unshipped language");
    });
  });

  it("writes UTF-16 with a BOM — the stub opens these as Unicode", () => {
    withTempDir((dir) => {
      writeWindowsMessages(dir);
      const japanese = readFileSync(join(dir, "messages", `lcid-${0x11}.txt`));
      assert.equal(japanese[0], 0xff, "missing BOM");
      assert.equal(japanese[1], 0xfe, "missing BOM");
      const text = japanese.subarray(2).toString("utf16le");
      assert.equal(text, renderNodeMissingText("ja"));
      // Guards the encoding end to end: a codepage guess would turn the
      // Japanese title into mojibake in the one dialog that matters.
      assert.ok(text.split("\n")[0].length > 0);
    });
  });

  it("gives every file the text its own language resolves to", () => {
    withTempDir((dir) => {
      writeWindowsMessages(dir);
      windowsMessageFileTargets().forEach(({ primaryLanguageId, locale }) => {
        const raw = readFileSync(join(dir, "messages", `lcid-${primaryLanguageId}.txt`))
          .subarray(2)
          .toString("utf16le");
        assert.equal(raw, renderNodeMissingText(locale), `lcid-${primaryLanguageId}`);
        assert.equal(locale, launcherLocaleForLcid(primaryLanguageId));
      });
    });
  });
});

describe("launch.vbs — the console window", () => {
  const stub = readFileSync(join(process.cwd(), "server", "utils", "launcher", "windows", "launch.vbs"), "utf8");

  it("never uses WshShell.Exec, which always creates a console window", () => {
    // Measured, not assumed: `Exec` allocates a console for a console
    // program, so `where node` would flash a black rectangle on EVERY
    // launch — on the one screen whose whole promise is that clicking an
    // icon just works. The stub walks %PATH% itself instead.
    // Case-insensitive: VBScript method names are, so `sh.EXEC(` would
    // slip past an exact-case guard and bring the console window back
    // without failing anything.
    assert.doesNotMatch(stub, /\.exec\s*\(/i, "the stub shells out somewhere — that is a visible console window on every launch");
  });

  it("hides every process it starts", () => {
    // `Run(cmd, 0, False)`: 0 hides the window, False detaches. Checked
    // per line rather than as one pattern so a second Run added later is
    // covered too — this is the whole reason the stub exists as a .vbs.
    const runLines = stub.split("\n").filter((line) => /\bsh\.run\s*\(?/i.test(line));
    assert.ok(runLines.length > 0, "no sh.Run found — has the stub been rewritten?");
    runLines.forEach((line) => {
      assert.match(line.trim(), /,\s*0,\s*false$/i, `this Run is not hidden and detached: ${line.trim()}`);
    });
  });
});

describe("Windows install locations", () => {
  it("puts the launcher's files under LOCALAPPDATA, which does not roam", () => {
    const root = windowsLauncherRoot({ env: { LOCALAPPDATA: String.raw`C:\Users\a\AppData\Local` }, home: String.raw`C:\Users\a` });
    assert.equal(root, join(String.raw`C:\Users\a\AppData\Local`, "MulmoClaude"));
  });

  it("falls back to the conventional path when the env var is missing or blank", () => {
    const home = String.raw`C:\Users\a`;
    const expected = join(home, "AppData", "Local", "MulmoClaude");
    assert.equal(windowsLauncherRoot({ env: {}, home }), expected);
    assert.equal(windowsLauncherRoot({ env: { LOCALAPPDATA: "   " }, home }), expected);
  });

  it("puts the shortcut in the Start Menu, the closest thing to /Applications", () => {
    const dir = defaultShortcutDir({ env: { APPDATA: String.raw`C:\Users\a\AppData\Roaming` }, home: String.raw`C:\Users\a` });
    assert.equal(dir, join(String.raw`C:\Users\a\AppData\Roaming`, "Microsoft", "Windows", "Start Menu", "Programs"));
  });

  it("honours --dir for the shortcut while keeping the launcher files where they belong", () => {
    const chosen = String.raw`C:\Users\a\Desktop`;
    const { installDir, shortcutPath, rootDir } = resolveShortcutPath(chosen);
    assert.equal(installDir, chosen);
    assert.equal(shortcutPath, join(chosen, "MulmoClaude.lnk"));
    assert.notEqual(rootDir, chosen, "--dir moves the shortcut, not the launcher's own files");
  });
});
