// Windows support: the Windows branches as logic on any machine, and the real thing on the Windows CI runner.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBackup, restoreFile } from "../src/spine/backup.js";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath, fileKey, windowsSetupWarnings, fileKeyOr, fontCandidates, lf, parseProcessList, processList, readJson, renderFolder, retryLocked, runFile, spineUserDir, splitCommandLine, unityPath, type ReplaceOps } from "../src/platform.js";
import { findRhubarb } from "../src/spine/lipsync.js";
import { rasterizeSvg } from "../src/spine/svgraster.js";
import { launchChrome, SPINE_WEBGL } from "../src/spine/chrome.js";
import { PNG } from "pngjs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { defaultSpineBin, defaultWorkDir } from "../src/config.js";
import { editorStatus, isEditorProcess, setEditorProbe, useStaging } from "../src/spine/editor.js";
import { unityHasProjectOpen } from "../src/spine/unity-import.js";

const WIN_BIN = "C:\\Program Files\\Spine\\Spine.com";

describe("process lists and command lines", () => {
  it("reads 'pid command line' lines with CRLF endings and empty command lines", () => {
    expect(parseProcessList("12 \"C:\\Program Files\\Spine\\Spine.exe\"\r\n4 \r\n\r\n99 node x.js\n")).toEqual([
      { pid: 12, args: "\"C:\\Program Files\\Spine\\Spine.exe\"" }, { pid: 4, args: "" }, { pid: 99, args: "node x.js" },
    ]);
  });

  it("splits the executable from its arguments, quoted or not", () => {
    expect(splitCommandLine("\"C:\\Program Files\\Spine\\Spine.exe\" -u 4.3.26")).toEqual({ exe: "C:\\Program Files\\Spine\\Spine.exe", rest: " -u 4.3.26" });
    expect(splitCommandLine("C:\\Spine\\Spine.com")).toEqual({ exe: "C:\\Spine\\Spine.com", rest: "" });
    expect(splitCommandLine("/usr/bin/ps -ax")).toEqual({ exe: "/usr/bin/ps", rest: " -ax" });
  });
});

describe("Spine editor on Windows", () => {
  afterEach(() => setEditorProbe({ processes: () => [], settingsDir: "" }));

  it("tells editor windows from CLI runs, with quoted paths", () => {
    const is = (args: string) => isEditorProcess({ pid: 1, args }, WIN_BIN, "win32");
    expect(is("\"C:\\Program Files\\Spine\\Spine.exe\"")).toBe(true);
    expect(is("\"C:\\Program Files\\Spine\\Spine.exe\" \"D:\\Art\\Hero Rig\\hero.spine\"")).toBe(true);
    expect(is("D:\\Tools\\Spine\\Spine.com -u 4.3.26")).toBe(true);
    expect(is("\"C:\\Program Files\\Spine\\Spine.com\" -u 4.3.26 -i \"D:\\Art\\hero.spine\" -o C:\\out -e json")).toBe(false);
    expect(is("\"C:\\Program Files\\Java\\bin\\javaw.exe\" -cp \"C:\\Program Files\\Spine\\spine.jar\" Launcher")).toBe(true);
    expect(is("\"C:\\Windows\\System32\\notepad.exe\" C:\\spine\\notes.txt")).toBe(false);
    expect(is("\"C:\\Program Files\\nodejs\\node.exe\" C:\\src\\spine-mcp\\dist\\index.js")).toBe(false);
  });

  it("treats an unreadable process list as unknown: writes go to the staging copy", () => {
    setEditorProbe({ processes: () => null });
    const s = editorStatus(WIN_BIN, "C:\\p\\hero.spine");
    expect(s).toMatchObject({ running: false, unknown: true, projectOpen: "possible" });
    expect(useStaging("auto", s)).toBe(true);
    expect(useStaging("inPlace", s)).toBe(false);
  });
});

describe("Unity editor on Windows", () => {
  it("finds Unity.exe with a quoted -projectpath (spaces, non-ASCII), not batch runs; unknown stays unknown", () => {
    const project = "C:\\Users\\Berkan Işık\\Games\\My Game";
    const exe = "\"C:\\Program Files\\Unity\\Hub\\Editor\\6000.6.2f1\\Editor\\Unity.exe\"";
    expect(unityHasProjectOpen(project, () => `${exe} -projectpath "${project}" -useHub -hubIPC`)).toBe(true);
    expect(unityHasProjectOpen(project, () => `${exe} -projectPath "c:\\users\\berkan işık\\games\\my game\\"`)).toBe(true);
    expect(unityHasProjectOpen(project, () => `${exe} -batchmode -projectPath "${project}" -executeMethod X`)).toBe(false);
    expect(unityHasProjectOpen(project, () => `${exe} -projectpath "C:\\Users\\Berkan Işık\\Games\\Other"`)).toBe(false);
    expect(unityHasProjectOpen(project, () => "\"C:\\Program Files\\Unity Hub\\Unity Hub.exe\"")).toBe(false);
    expect(unityHasProjectOpen(project, () => null)).toBeNull();
  });
});

describe.runIf(process.platform !== "win32")("the real process list (macOS, Linux)", () => {
  it("lists this process", () => {
    expect(processList()?.some((p) => p.pid === process.pid)).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("the real process list (Windows)", () => {
  it("lists a running process with its full command line, non-ASCII included", async () => {
    const marker = `spine-mcp-Işık-${Date.now()}`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", marker], { windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const list = processList();
      expect(list).not.toBeNull();
      const found = list!.find((p) => p.pid === child.pid);
      expect(found?.args).toContain(marker);
      expect(isEditorProcess(found!, WIN_BIN)).toBe(false);
    } finally {
      child.kill();
    }
  }, 60_000);
});

const lockErr = (code = "EBUSY") => Object.assign(new Error(`${code}: resource busy or locked`), { code });

/** A project with a backup of its first state, then changed (as an import would). */
function restorable() {
  const dir = mkdtempSync(join(tmpdir(), "spine-mcp-lock-"));
  const project = join(dir, "hero.spine");
  writeFileSync(project, "before");
  const backup = createBackup({ ...loadConfig(), workDir: join(dir, "work") }, project, "test");
  writeFileSync(project, "after import");
  return { dir, project, backup };
}

describe("restoring a backup while another program holds the project", () => {
  it("retries lock errors and gives up on others", () => {
    let n = 0;
    expect(retryLocked(() => { if (++n < 3) throw lockErr(); return "ok"; })).toBe("ok");
    expect(n).toBe(3);
    expect(() => retryLocked(() => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); })).toThrow(/gone/);
  });

  it("copies the backup over the project when the rename keeps failing", () => {
    const { project, backup } = restorable();
    const ops: ReplaceOps = { rename: () => { throw lockErr("EPERM"); }, copy: copyFileSync, remove: (p) => rmSync(p, { force: true }) };
    restoreFile(backup, project, ops);
    expect(readFileSync(project, "utf8")).toBe("before");
  });

  it("says the project is NOT restored, and where the backup is, when nothing gets through", () => {
    const { project, backup } = restorable();
    const ops: ReplaceOps = { rename: () => { throw lockErr(); }, copy: () => { throw lockErr(); }, remove: (p) => rmSync(p, { force: true }) };
    expect(() => restoreFile(backup, project, ops)).toThrow(new RegExp(`NOT restored.*${backup.file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*backupId "${backup.id}"`));
    expect(readFileSync(project, "utf8")).toBe("after import");
    // A normal restore still goes through the atomic rename.
    restoreFile(backup, project, { rename: renameSync, copy: () => { throw new Error("not used"); }, remove: (p) => rmSync(p, { force: true }) });
    expect(readFileSync(project, "utf8")).toBe("before");
  });
});

describe.runIf(process.platform === "win32")("a file held open without sharing (Windows)", () => {
  /** PowerShell opens the file with FileShare None (as an editor or a sync client can) for `ms` milliseconds. */
  const hold = async (file: string, ms: number) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$f=[IO.File]::Open('${file}','Open','ReadWrite','None'); Write-Output locked; Start-Sleep -Milliseconds ${ms}; $f.Close()`], { windowsHide: true });
    await new Promise<void>((resolve) => ps.stdout.on("data", (d) => { if (String(d).includes("locked")) resolve(); }));
    return ps;
  };

  it("restores once the lock goes away within the retries", async () => {
    const { project, backup } = restorable();
    const ps = await hold(project, 600);
    restoreFile(backup, project);
    expect(readFileSync(project, "utf8")).toBe("before");
    ps.kill();
  }, 60_000);

  it("reports a failed restore while the lock stays", async () => {
    const { project, backup } = restorable();
    const ps = await hold(project, 15_000);
    try {
      expect(() => restoreFile(backup, project)).toThrow(/NOT restored/);
    } finally {
      ps.kill();
    }
  }, 60_000);
});

describe("paths and names", () => {
  it("keys files as before on macOS and Linux, case-blind on Windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-key-"));
    const f = join(dir, "Hero.spine");
    writeFileSync(f, "x");
    // macOS / Linux: the real path, byte for byte what backups, the step log and the write lock always used.
    expect(fileKey(f, "darwin")).toBe(realpathSync(f));
    expect(fileKeyOr(join(dir, "Missing.spine"), "linux")).toBe(join(dir, "Missing.spine"));
    expect(fileKeyOr("C:\\Art\\Missing.spine", "win32")).toBe("c:\\art\\missing.spine");
    // Windows, an existing file: the real path, lower case, the same whatever case it was asked in.
    if (process.platform === "win32") {
      expect(fileKey(f.toUpperCase(), "win32")).toBe(fileKey(f, "win32"));
      expect(fileKey(f, "win32")).toBe(fileKey(f, "win32").toLowerCase());
    }
  });

  it("writes Unity asset paths with forward slashes and render folders the Unity script can name the same", () => {
    expect(unityPath("Assets\\Spine\\hero")).toBe("Assets/Spine/hero");
    expect(unityPath("Assets/Spine/hero")).toBe("Assets/Spine/hero");
    expect(renderFolder("walk")).toBe("walk");
    expect(renderFolder("run.fast-2")).toBe("run.fast-2");
    expect(renderFolder("attack/heavy")).toBe(`x${Buffer.from("attack/heavy").toString("hex")}`);
    expect(renderFolder("bekle:ışık?")).toBe(`x${Buffer.from("bekle:ışık?").toString("hex")}`);
    expect(renderFolder("idle.")).toMatch(/^x/);
    // Long names keep a prefix and a hash of the whole name: two that share their first 60 bytes stay apart.
    const long = `characters/hero/combat/sword/attack_heavy_charged_release_overhead_`;
    expect(renderFolder(`${long}01`)).not.toBe(renderFolder(`${long}02`));
    expect(renderFolder(`${long}01`)).toMatch(/^x[0-9a-f]{88}-[0-9a-f]{16}$/);
    expect(renderFolder("a".repeat(200)).length).toBe(106);
  });

  it("reads JSON saved with a byte order mark and text with CRLF line ends", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-bom-"));
    writeFileSync(join(dir, "manifest.json"), "\uFEFF{\"dependencies\":{\"a\":\"1\"}}");
    expect(readJson(join(dir, "manifest.json"))).toEqual({ dependencies: { a: "1" } });
    expect(lf("a\r\nb\nc\r\n")).toBe("a\nb\nc\n");
  });

  it("knows where Spine and the cache live, whatever the host", () => {
    // The home folder is the host's; what follows it is the platform's own layout, with its own separators.
    expect(defaultSpineBin("linux")).toMatch(/\/Spine\/Spine\.sh$/);
    expect(defaultWorkDir("darwin")).toMatch(/\/Library\/Caches\/spine-mcp$/);
    expect(defaultWorkDir("win32", {})).toMatch(/AppData\\Local\\spine-mcp$/);
  });
});

describe("running programs with a timeout", () => {
  it("rejects as killed when the program runs too long", async () => {
    await expect(runFile(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeout: 500 })).rejects.toMatchObject({ killed: true, message: expect.stringMatching(/timed out after 500 ms/) });
    await expect(runFile(process.execPath, ["-e", "process.stdout.write('ok')"], { timeout: 10_000 })).resolves.toMatchObject({ stdout: "ok" });
  }, 30_000);
});

describe.runIf(process.platform === "win32")("ending a process tree (Windows)", () => {
  it("ends what the timed-out program started too (Spine.com's Java, Unity's workers)", async () => {
    const marker = `spine-mcp-grandchild-${Date.now()}`;
    const pidFile = join(mkdtempSync(join(tmpdir(), "spine-mcp-tree-")), "pid");
    // The parent records the grandchild's pid, so the test knows it was running before the kill.
    const parent = `const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "${marker}"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 60000)`;
    await expect(runFile(process.execPath, ["-e", parent], { timeout: 3000 })).rejects.toMatchObject({ killed: true });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    // taskkill /T returns before Windows has torn the tree down; under load (a full Spine + Unity run) that takes more
    // than a second (G120). Gone within 15 s is a kill; still there after is the regression this test is for.
    const alive = () => processList()!.some((p) => p.pid === pid || p.args.includes(marker));
    for (let waited = 0; alive() && waited < 15_000; waited += 500) await new Promise((r) => setTimeout(r, 500));
    expect(alive()).toBe(false);
  }, 60_000);
});

describe("where things are", () => {
  it("finds programs on the PATH with Windows extensions, without which or where", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-path-"));
    writeFileSync(join(dir, "rhubarb.exe"), "");
    writeFileSync(join(dir, "magick"), "");
    // Windows rules (";" lists, PATHEXT) on any host; the extension spelled as the file is (Linux is case-sensitive).
    expect(findOnPath("rhubarb", "win32", { PATH: `${join(dir, "nope")};${dir}`, PATHEXT: ".COM;.exe" })).toBe(join(dir, "rhubarb.exe"));
    if (process.platform !== "win32") {
      expect(findOnPath("magick", process.platform, { PATH: `/nope:${dir}` })).toBe(join(dir, "magick"));
      expect(findOnPath("ffmpeg", process.platform, { PATH: dir })).toBeNull();
    }
  });

  it("finds Rhubarb unpacked under LOCALAPPDATA on Windows", () => {
    const local = mkdtempSync(join(tmpdir(), "spine-mcp-local-"));
    mkdirSync(join(local, "rhubarb", "Rhubarb-Lip-Sync-1.14.0-Windows"), { recursive: true });
    writeFileSync(join(local, "rhubarb", "Rhubarb-Lip-Sync-1.14.0-Windows", "rhubarb.exe"), "");
    expect(findRhubarb({ LOCALAPPDATA: local, PATH: "" }, "win32")).toMatch(/Rhubarb-Lip-Sync-1\.14\.0-Windows[\\/]rhubarb\.exe$/);
  });

  it("knows Spine's own folder and font files per platform", () => {
    expect(spineUserDir("win32", "C:\\Users\\Berkan Işık")).toBe("C:\\Users\\Berkan Işık\\Spine");
    expect(spineUserDir("linux", "/home/b")).toBe("/home/b/.spine");
    expect(spineUserDir("darwin", "/Users/b")).toBe("/Users/b/Library/Application Support/Spine");
    const fonts = fontCandidates(true, { WINDIR: "C:\\Windows" });
    expect(fonts[0]).toBe("/System/Library/Fonts/Supplemental/Arial Bold.ttf"); // macOS first, as before
    expect(fonts).toContain("C:/Windows/Fonts/arialbd.ttf");
  });
});

const hasMagick = (() => { try { execFileSync("magick", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.runIf(hasMagick)("ImageMagick with this system's paths", () => {
  it("draws chart text with a font file found here, through an MVG file given by full path", () => {
    const font = fontCandidates().find((f) => existsSync(f));
    expect(font, "a font file for labels").toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-label-"));
    const png = join(dir, "label.png");
    rasterizeSvg('<svg width="240" height="60"><text x="10" y="45" font-size="36" fill="#000000">Hello</text></svg>', join(dir, "label.mvg"), png);
    const img = PNG.sync.read(readFileSync(png));
    let dark = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i]! < 80) dark++;
    expect(dark).toBeGreaterThan(200); // the letters are there
  });

  it("reads the label font itself, not ImageMagick's fallback", () => {
    // A font ImageMagick cannot read is only a warning: the text is drawn in its default font, so check stderr.
    for (const font of [fontCandidates(true), fontCandidates()].map((l) => l.find((f) => existsSync(f)))) {
      const dir = mkdtempSync(join(tmpdir(), "spine-mcp-font-"));
      const r = spawnSync("magick", ["-background", "none", "-fill", "white", "-font", font!, "-pointsize", "20", "label:Bolt", join(dir, "l.png")], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toMatch(/unable to read font/i);
    }
  });
});

describe("doctor advice on Windows", () => {
  it("warns about a non-ASCII or long work folder and a script as SPINE_BIN, only on Windows", () => {
    const w = windowsSetupWarnings("C:\\Users\\Berkan Işık\\OneDrive\\Documents\\Tools\\caches\\spine-mcp", "C:\\Tools\\spine.cmd", "win32");
    expect(w.join(" ")).toMatch(/non-ASCII.*SPINE_MCP_WORKDIR/);
    expect(w.join(" ")).toMatch(/characters: spine_unity_check/);
    expect(w.join(" ")).toMatch(/\.cmd script/);
    expect(windowsSetupWarnings("C:\\spine-mcp", "C:\\Program Files\\Spine\\Spine.com", "win32")).toEqual([]);
    expect(windowsSetupWarnings("/Users/Işık/Library/Caches/spine-mcp", "/x/Spine", "darwin")).toEqual([]);
  });
});

// CI sets REQUIRE_CHROME=1: there a missing Chrome is a failure, elsewhere the test is skipped.
const chromeCheck = process.env.REQUIRE_CHROME === "1" ? it : it.skipIf(!!process.env.SKIP_CHROME);

describe("headless Chrome as the web tools start it", () => {
  chromeCheck("starts Chrome, loads spine-webgl by file path and gets a WebGL context", async () => {
    let browser;
    try {
      browser = await launchChrome("the Chrome test");
    } catch (e) {
      if (process.env.REQUIRE_CHROME === "1" || !/Could not start Chrome/.test((e as Error).message)) throw e;
      return; // no Chrome on this machine
    }
    try {
      const page = await browser.newPage();
      await page.setContent("<canvas id=c width=64 height=64></canvas>");
      await page.addScriptTag({ path: SPINE_WEBGL });
      const r = await page.evaluate(() => {
        const w = window as unknown as { spine?: Record<string, unknown> };
        const gl = (document.getElementById("c") as HTMLCanvasElement).getContext("webgl");
        return { runtime: typeof w.spine?.SkeletonJson, renderer: typeof w.spine?.SceneRenderer, webgl: !!gl };
      });
      expect(r).toEqual({ runtime: "function", renderer: "function", webgl: true });
    } finally {
      await browser.close();
    }
  }, 120_000);
});
