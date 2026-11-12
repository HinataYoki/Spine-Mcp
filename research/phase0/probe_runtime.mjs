// Probe: load a Spine 4.3 JSON headless (no atlas, no images) with spine-core 4.3,
// sample every animation with physics, and report timing, bounds and NaN checks.
// Usage: node probe_runtime.mjs <spine-core dist dir> <skeleton.json> [fps]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [distDir, jsonPath, fpsArg] = process.argv.slice(2);
const spine = await import(pathToFileURL(join(distDir, "index.js")).href);
const fps = Number(fpsArg ?? 30);

// Fake full-texture region so region/mesh attachments can compute geometry without an atlas.
class NoAtlasLoader {
  fill(sequence) {
    for (let i = 0; i < sequence.regions.length; i++) {
      const r = new spine.TextureRegion();
      Object.assign(r, { u: 0, v: 0, u2: 1, v2: 1, degrees: 0, offsetX: 0, offsetY: 0 });
      sequence.regions[i] = r;
    }
  }
  newRegionAttachment(skin, placeholder, name, path, sequence) { this.fill(sequence); return new spine.RegionAttachment(name, sequence); }
  newMeshAttachment(skin, placeholder, name, path, sequence) { this.fill(sequence); return new spine.MeshAttachment(name, sequence); }
  newBoundingBoxAttachment(skin, placeholder, name) { return new spine.BoundingBoxAttachment(name); }
  newPathAttachment(skin, placeholder, name) { return new spine.PathAttachment(name); }
  newPointAttachment(skin, placeholder, name) { return new spine.PointAttachment(name); }
  newClippingAttachment(skin, placeholder, name) { return new spine.ClippingAttachment(name); }
}

const t0 = performance.now();
const reader = new spine.SkeletonJson(new NoAtlasLoader());
const data = reader.readSkeletonData(JSON.parse(readFileSync(jsonPath, "utf8")));
const tLoad = performance.now() - t0;

// Region sizes are only known after parsing; patch them so updateRegion yields correct offsets.
for (const skin of data.skins) {
  for (const entry of skin.getAttachments()) {
    const a = entry.attachment;
    if (a instanceof spine.RegionAttachment) {
      for (const r of a.sequence.regions) Object.assign(r, { width: a.width, height: a.height, originalWidth: a.width, originalHeight: a.height });
      a.updateSequence();
    }
  }
}

const skeleton = new spine.Skeleton(data);
const stateData = new spine.AnimationStateData(data);
const report = { skeleton: data.name, version: data.version, bones: data.bones.length, slots: data.slots.length,
  constraints: data.constraints?.length, loadMs: +tLoad.toFixed(1), animations: [] };

for (const anim of data.animations) {
  const state = new spine.AnimationState(stateData);
  skeleton.setupPose();
  state.setAnimation(0, anim.name, true);
  const frames = Math.max(1, Math.round(anim.duration * fps));
  const dt = 1 / fps;
  let nan = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const t1 = performance.now();
  for (let f = 0; f <= frames; f++) {
    if (f > 0) { state.update(dt); skeleton.update(dt); }
    state.apply(skeleton);
    skeleton.updateWorldTransform(spine.Physics.update);
    for (const bone of skeleton.bones) {
      const p = bone.appliedPose;
      const x = p.worldX, y = p.worldY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) nan++;
    }
    const b = skeleton.getBoundsRect();
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  }
  report.animations.push({ name: anim.name, duration: +anim.duration.toFixed(3), frames, nanBones: nan,
    bounds: [minX, minY, maxX, maxY].map(v => +v.toFixed(1)), ms: +(performance.now() - t1).toFixed(1) });
}
console.log(JSON.stringify(report, null, 1));
