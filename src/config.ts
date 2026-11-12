import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, posix, resolve, win32 } from "node:path";
import { UserError } from "./spine/project.js";

/** Runtime configuration, overridable through environment variables. */
export interface Config {
  /** Spine launcher binary. */
  spineBin: string;
  /** Editor version passed to `-u` so every CLI call uses the same editor build. Empty disables pinning. */
  spineVersion: string;
  /** Folder for exports, renders and caches. Never inside a user project. */
  workDir: string;
  /** Per-call CLI timeout. */
  cliTimeoutMs: number;
  profile: Profile | null;
  profileError?: string;
}

export interface TextureProfile {
  type?: "default" | "sprite";
  spriteMode?: "single" | "multiple";
  sRGB?: boolean;
  alphaIsTransparency?: boolean;
  mipmaps?: boolean;
  maxSize?: number;
  platforms?: { target: string; format: string; maxSize?: number }[];
}

export interface Profile {
  name: string;
  file: string;
  tools: Record<string, Record<string, unknown>>;
  export?: { maxPages?: number; sidesMultipleOf?: number };
  unity?: {
    texture?: TextureProfile;
    spriteSlices?: boolean;
    graphic?: { canvasGroupCompatible?: boolean; pmaVertexColors?: boolean; material?: string };
  };
}

export function readProfile(file: string): Profile {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Profile>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
  const tools = raw.tools ?? {};
  if (typeof tools !== "object" || Array.isArray(tools) || Object.values(tools).some((v) => !v || typeof v !== "object" || Array.isArray(v))) throw new Error("tools must map tool names to objects of default arguments");
  const platforms = raw.unity?.texture?.platforms ?? [];
  if (!Array.isArray(platforms) || platforms.some((p) => !p?.target || !p?.format)) throw new Error("unity.texture.platforms entries need target and format");
  return { ...raw, name: raw.name ?? basename(file, ".json"), file, tools } as Profile;
}

export function withProfile<A extends Record<string, unknown>>(config: Config, tool: string, args: A, shadowed: string[] = []): { args: A; defaults: string[] } {
  if (config.profileError) throw new UserError(`SPINE_MCP_PROFILE: ${config.profileError}`);
  // `shadowed`: options the caller chose some other way (a preset), so a profile default must not override them.
  const defaults = Object.fromEntries(Object.entries(config.profile?.tools[tool] ?? {}).filter(([k]) => !shadowed.includes(k)));
  const given = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  const applied = Object.keys(defaults).filter((k) => !(k in given));
  return { args: { ...defaults, ...given } as A, defaults: applied };
}

interface PageList { file: string; pages: { width: number; height: number }[] }
interface TextureRow { texture?: string; material: string; platforms?: Record<string, { overridden: boolean; maxTextureSize: number; format: string }> }

export function profileFindings(profile: Profile, result: { atlases?: PageList[]; textures?: TextureRow[] }): string[] {
  const out: string[] = [];
  const maxPages = profile.export?.maxPages, multiple = profile.export?.sidesMultipleOf;
  for (const a of result.atlases ?? []) {
    if (maxPages && a.pages.length > maxPages) out.push(`${a.file}: ${a.pages.length} pages, the profile allows ${maxPages}.`);
    if (multiple) for (const p of a.pages) if (p.width % multiple || p.height % multiple) out.push(`${a.file}: page ${p.width}x${p.height}, the profile wants sides divisible by ${multiple}.`);
  }
  for (const t of result.textures ?? []) {
    const page = t.texture?.split("/").pop() ?? t.material;
    for (const want of profile.unity?.texture?.platforms ?? []) {
      const got = Object.entries(t.platforms ?? {}).find(([k]) => k.toLowerCase() === want.target.toLowerCase() || (k === "iPhone" && want.target.toLowerCase() === "ios"))?.[1];
      if (!got || !got.overridden || got.format.replace(/^ASTC_RGBA_/, "ASTC_") !== want.format) out.push(`${page}: ${want.target} imports as ${got?.overridden ? got.format : "no override"}, the profile wants ${want.format}.`);
    }
  }
  return out;
}

export function profileReport<R extends object>(config: Config, defaults: string[], result: R, textures = false): R {
  const p = config.profile;
  if (!p) return result;
  const r = result as { atlases?: PageList[]; textures?: TextureRow[] };
  const findings = profileFindings(p, { atlases: r.atlases, textures: textures ? r.textures : undefined });
  return { ...result, profile: { name: p.name, file: p.file, defaults, ...(findings.length ? { findings } : {}) } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let profile: Profile | null = null, profileError: string | undefined;
  if (env.SPINE_MCP_PROFILE) {
    try { profile = readProfile(resolve(env.SPINE_MCP_PROFILE)); } catch (e) { profileError = `${env.SPINE_MCP_PROFILE}: ${(e as Error).message}`; }
  }
  return {
    profile,
    ...(profileError ? { profileError } : {}),
    // Absolute: the Spine CLI runs in its own empty folder (G115), so a relative path would point inside it.
    spineBin: env.SPINE_BIN ? resolve(env.SPINE_BIN) : defaultSpineBin(),
    spineVersion: env.SPINE_VERSION ?? "4.3.26",
    workDir: env.SPINE_MCP_WORKDIR ? resolve(env.SPINE_MCP_WORKDIR) : defaultWorkDir(),
    cliTimeoutMs: positiveNumber(env.SPINE_CLI_TIMEOUT_MS, 180_000),
  };
}

/** Where Spine installs by default. Windows and Linux paths are Esoteric's defaults, untested here (macOS is). */
export function defaultSpineBin(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return win32.join(env.ProgramFiles ?? "C:\\Program Files", "Spine", "Spine.com"); // the console launcher (Spine.exe has no CLI output)
  if (platform === "linux") return posix.join(homedir(), "Spine", "Spine.sh");
  return "/Applications/Spine.app/Contents/MacOS/Spine";
}

export function defaultWorkDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  if (platform === "win32") return env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "spine-mcp") : home ? win32.join(home, "AppData", "Local", "spine-mcp") : join(tmpdir(), "spine-mcp");
  if (platform === "linux" && home) return posix.join(env.XDG_CACHE_HOME ?? posix.join(home, ".cache"), "spine-mcp");
  return home ? posix.join(home, "Library", "Caches", "spine-mcp") : join(tmpdir(), "spine-mcp");
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}
