import * as spine from "@esotericsoftware/spine-core";
import type { SkeletonJson } from "./types.js";

/**
 * Loads skeleton JSON with the official spine-core 4.3 runtime, without an atlas or images.
 * Regions get a fake full-texture region sized from the attachment, so world geometry and bounds are correct;
 * UVs are meaningless (nothing is rendered here).
 */
class NoAtlasLoader implements spine.AttachmentLoader {
  private fill(sequence: spine.Sequence) {
    for (let i = 0; i < sequence.regions.length; i++) {
      const r = new spine.TextureRegion();
      Object.assign(r, { u: 0, v: 0, u2: 1, v2: 1, degrees: 0, offsetX: 0, offsetY: 0, width: 1, height: 1, originalWidth: 1, originalHeight: 1 });
      sequence.regions[i] = r;
    }
  }
  newRegionAttachment(_skin: spine.Skin, _placeholder: string, name: string, _path: string, sequence: spine.Sequence) {
    this.fill(sequence);
    return new spine.RegionAttachment(name, sequence);
  }
  newMeshAttachment(_skin: spine.Skin, _placeholder: string, name: string, _path: string, sequence: spine.Sequence) {
    this.fill(sequence);
    return new spine.MeshAttachment(name, sequence);
  }
  newBoundingBoxAttachment(_skin: spine.Skin, _placeholder: string, name: string) { return new spine.BoundingBoxAttachment(name); }
  newPathAttachment(_skin: spine.Skin, _placeholder: string, name: string) { return new spine.PathAttachment(name); }
  newPointAttachment(_skin: spine.Skin, _placeholder: string, name: string) { return new spine.PointAttachment(name); }
  newClippingAttachment(_skin: spine.Skin, _placeholder: string, name: string) { return new spine.ClippingAttachment(name); }
}

export function loadSkeletonData(doc: SkeletonJson, name?: string): spine.SkeletonData {
  const reader = new spine.SkeletonJson(new NoAtlasLoader());
  const data = reader.readSkeletonData(doc as unknown as object);
  if (name) data.name = name;
  // Region sizes are only known after parsing (GOTCHAS G12).
  for (const skin of data.skins) {
    for (const entry of skin.getAttachments()) {
      const a = entry.attachment;
      if (a instanceof spine.RegionAttachment) {
        for (const r of a.sequence.regions) {
          if (r) Object.assign(r, { width: a.width, height: a.height, originalWidth: a.width, originalHeight: a.height });
        }
        a.updateSequence();
      }
    }
  }
  return data;
}

export { spine };
