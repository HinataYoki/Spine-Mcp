/** Parsed `Spine -i <path>` output. Lists come from the CLI's comma-joined text, so names containing ", " split wrongly;
 * use the exported JSON when exact names matter. */
export interface ProjectInfo {
  path: string | null;
  spineVersion: string | null;
  dopesheetFps: number | null;
  skeletons: SkeletonInfo[];
}

export interface SkeletonInfo {
  name: string;
  width: number | null;
  height: number | null;
  /** Keyed by the CLI label, e.g. "Bones", "IK constraints", "Physics constraints", "Sliders", "Animations". */
  lists: Record<string, { count: number; names: string[] }>;
}

const nullable = (v: string) => (v === "null" ? null : v);

export function parseProjectInfo(lines: string[]): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  let project: ProjectInfo | undefined;
  let skeleton: SkeletonInfo | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Project info: (.*)$/))) {
      project = { path: nullable(m[1]!), spineVersion: null, dopesheetFps: null, skeletons: [] };
      skeleton = undefined;
      projects.push(project);
    } else if (!project) {
      continue;
    } else if ((m = line.match(/^Spine version: (.*)$/))) {
      project.spineVersion = nullable(m[1]!);
    } else if ((m = line.match(/^Dopesheet FPS: (.*)$/))) {
      project.dopesheetFps = Number(m[1]);
    } else if ((m = line.match(/^Skeleton: (.*)$/))) {
      skeleton = { name: m[1]!, width: null, height: null, lists: {} };
      project.skeletons.push(skeleton);
    } else if (skeleton && (m = line.match(/^Size: ([\d.\-]+) x ([\d.\-]+)$/))) {
      skeleton.width = Number(m[1]);
      skeleton.height = Number(m[2]);
    } else if (skeleton && (m = line.match(/^(.+?) \((\d+)\): (.*)$/))) {
      skeleton.lists[m[1]!] = { count: Number(m[2]), names: m[3]!.split(", ").filter(Boolean) };
    }
  }
  return projects;
}
