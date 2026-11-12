/** Minimal Spine 4.3 JSON types: only the fields this server reads. Unknown fields are kept as-is. */

export type Curve = "stepped" | number[];

export interface Key {
  time?: number;
  value?: number;
  x?: number;
  y?: number;
  curve?: Curve;
  name?: string | null;
  [k: string]: unknown;
}

export interface BoneJson {
  name: string;
  parent?: string;
  length?: number;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
  inherit?: string;
  skin?: boolean;
  color?: string;
  icon?: string;
  [k: string]: unknown;
}

export interface SlotJson {
  name: string;
  bone: string;
  attachment?: string;
  color?: string;
  dark?: string;
  blend?: string;
  [k: string]: unknown;
}

export type ConstraintType = "ik" | "transform" | "path" | "physics" | "slider";

export interface ConstraintJson {
  type: ConstraintType;
  name: string;
  skin?: boolean;
  bones?: string[];
  bone?: string;
  target?: string;
  source?: string;
  slot?: string;
  animation?: string;
  [k: string]: unknown;
}

export interface AttachmentJson {
  type?: string;
  name?: string;
  path?: string;
  parent?: string;
  skin?: string;
  width?: number;
  height?: number;
  uvs?: number[];
  triangles?: number[];
  vertices?: number[];
  vertexCount?: number;
  hull?: number;
  end?: string;
  [k: string]: unknown;
}

export interface SkinJson {
  name: string;
  bones?: string[];
  constraints?: string[];
  attachments?: Record<string, Record<string, AttachmentJson>>;
  [k: string]: unknown;
}

export type TimelineMap = Record<string, Key[]>;

export interface AnimationJson {
  bones?: Record<string, TimelineMap>;
  slots?: Record<string, TimelineMap>;
  ik?: Record<string, Key[]>;
  transform?: Record<string, Key[]>;
  path?: Record<string, TimelineMap>;
  physics?: Record<string, TimelineMap | Key[]>;
  slider?: Record<string, TimelineMap | Key[]>;
  attachments?: Record<string, Record<string, Record<string, TimelineMap>>>;
  drawOrder?: Key[];
  /** 4.3: draw order keys scoped to a folder of slots. */
  drawOrderFolder?: { slots?: string[]; keys?: Key[] }[];
  events?: Key[];
  [k: string]: unknown;
}

export interface SkeletonJson {
  skeleton: { hash?: string; spine?: string; x?: number; y?: number; width?: number; height?: number; fps?: number; images?: string; audio?: string | null; [k: string]: unknown };
  bones: BoneJson[];
  slots?: SlotJson[];
  constraints?: ConstraintJson[];
  skins?: SkinJson[];
  events?: Record<string, unknown>;
  animations?: Record<string, AnimationJson>;
  [k: string]: unknown;
}
