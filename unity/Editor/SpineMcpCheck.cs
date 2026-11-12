// Batch-mode check run by spine-mcp (spine_unity_check): imports exported Spine runtime files with spine-unity's own
// importer, then samples every animation's bone world transforms so they can be compared with spine-core.
// Invoked as: Unity -batchmode -nographics -projectPath P -executeMethod SpineMcpCheck.Run
//   -spineMcpDir Assets/SpineMcp/<name> -spineMcpOut /abs/report.json -spineMcpSamples 20
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Spine;
using Spine.Unity;
using Spine.Unity.Editor;
using UnityEditor;
using UnityEditor.Presets;
using UnityEngine;

public static class SpineMcpCheck {
	/// <summary>Renders animations with SkeletonAnimation + an orthographic camera, framed on the animation's bounds at
	/// Spine's render scale, to transparent PNGs (renderDir/animation/frame_000.png), same frame times as Spine.</summary>
	static void RenderFrames (string dir, string renderDir, string animationList, float fps, float scalePercent) {
		string guid = AssetDatabase.FindAssets("t:SkeletonDataAsset", new[] { dir })[0];
		var asset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(guid));
		asset.Clear(); // default import scale (0.01) like a real project
		var components = NewSkeletonAnimation(asset);
		SkeletonRenderer renderer = components.skeletonRenderer;
		renderer.Initialize(true);
		Skeleton skeleton = renderer.Skeleton;
		var camGo = new GameObject("spine-mcp camera");
		var cam = camGo.AddComponent<Camera>();
		cam.orthographic = true;
		cam.clearFlags = CameraClearFlags.SolidColor;
		float grey = float.Parse(Arg("-spineMcpRenderGrey") ?? "0.4980", CultureInfo.InvariantCulture);
		cam.backgroundColor = new Color(grey, grey, grey, 1f);
		cam.nearClipPlane = 0.01f;
		cam.farClipPlane = 100f;
		float pxPerUnit = (scalePercent / 100f) / asset.scale;
		var names = string.IsNullOrEmpty(animationList) ? skeleton.Data.Animations.Select(a => a.Name).ToArray() : animationList.Split('|');
		float[] buffer = new float[8];
		foreach (string name in names) {
			Spine.Animation anim = skeleton.Data.FindAnimation(name);
			if (anim == null) continue;
			int frames = Math.Max(1, (int)Math.Round(anim.Duration * fps)); // like Spine's export (last frame excluded)
			// Bounds over all frames (like Spine's "max bounds").
			float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
			for (int k = 0; k < frames; k++) {
				Pose(skeleton, anim, k / fps, k == 0, 1f / fps);
				float bx, by, bw, bh;
				skeleton.GetBounds(out bx, out by, out bw, out bh, ref buffer);
				minX = Math.Min(minX, bx); minY = Math.Min(minY, by); maxX = Math.Max(maxX, bx + bw); maxY = Math.Max(maxY, by + bh);
			}
			int w = Math.Max(8, (int)Math.Ceiling((maxX - minX) * pxPerUnit)), h = Math.Max(8, (int)Math.Ceiling((maxY - minY) * pxPerUnit));
			var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
			cam.targetTexture = rt;
			cam.orthographicSize = (maxY - minY) / 2f;
			cam.aspect = (float)w / h;
			camGo.transform.position = new Vector3((minX + maxX) / 2f, (minY + maxY) / 2f, -10f);
			string outDir = Path.Combine(renderDir, RenderFolder(name));
			Directory.CreateDirectory(outDir);
			var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
			for (int k = 0; k < frames; k++) {
				Pose(skeleton, anim, k / fps, k == 0, 1f / fps);
				renderer.UpdateMesh(true);
				RenderCamera(cam, rt);
				RenderTexture.active = rt;
				tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
				tex.Apply();
				File.WriteAllBytes(Path.Combine(outDir, "frame_" + k.ToString("000") + ".png"), tex.EncodeToPNG());
			}
			RenderTexture.active = null;
			cam.targetTexture = null;
			rt.Release();
		}
	}


	/// <summary>
	/// The same frames drawn through UI: a SkeletonGraphic (material for the texture workflow and blend-mode materials
	/// detected, several CanvasRenderers when pages or blend modes need them, as GameObject > Spine > SkeletonGraphic
	/// does) under a World Space Canvas, seen by an orthographic camera framed on the skeleton's bounds.
	/// </summary>
	/// <summary>The SkeletonGraphic's settings without and with the CanvasGroup's detection (canvas group renders only).</summary>
	static string graphicSettingsAsIs, graphicSettingsDetected;

	static void RenderGraphicFrames (string dir, string renderDir, string animationList, float fps, float scalePercent, float groupAlpha) {
		string guid = AssetDatabase.FindAssets("t:SkeletonDataAsset", new[] { dir })[0];
		var asset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(guid));
		asset.Clear();
		var canvasGo = new GameObject("spine-mcp canvas", typeof(RectTransform), typeof(Canvas));
		var canvas = canvasGo.GetComponent<Canvas>();
		canvas.renderMode = RenderMode.WorldSpace;
		SkeletonGraphic graphic = EditorInstantiation.InstantiateSkeletonGraphic(asset, (Skin)null);
		SkeletonGraphicUtility.DetectMaterial(graphic);
		SkeletonGraphicUtility.DetectBlendModeMaterials(graphic);
		SkeletonData data = asset.GetSkeletonData(true);
		bool blends = data.Slots.Any(x => x.BlendMode != BlendMode.Normal);
		int pages = asset.atlasAssets.Where(x => x != null).Sum(x => x.MaterialCount);
		if (blends || pages > 1) graphic.allowMultipleCanvasRenderers = true;
		graphic.transform.SetParent(canvasGo.transform, false);
		graphic.rectTransform.anchoredPosition = Vector2.zero;
		graphic.Initialize(true);
		Skeleton skeleton = graphic.Skeleton;
		// Canvas units per Spine unit: the mesh is in skeleton units x asset scale x the canvas's reference pixels per unit.
		float k = asset.scale * canvas.referencePixelsPerUnit;
		var camGo = new GameObject("spine-mcp camera");
		var cam = camGo.AddComponent<Camera>();
		cam.orthographic = true;
		cam.clearFlags = CameraClearFlags.SolidColor;
		float grey = float.Parse(Arg("-spineMcpRenderGrey") ?? "0.4980", CultureInfo.InvariantCulture);
		cam.backgroundColor = new Color(grey, grey, grey, 1f);
		cam.nearClipPlane = 0.01f;
		cam.farClipPlane = 1000f;
		float pxPerUnit = scalePercent / 100f;
		var names = string.IsNullOrEmpty(animationList) ? skeleton.Data.Animations.Select(a => a.Name).ToArray() : animationList.Split('|');
		float[] buffer = new float[8];
		// Frames of every animation into renderDir/<animation>/<sub>.
		Action<string> shoot = sub => {
			foreach (string name in names) {
				Spine.Animation anim = skeleton.Data.FindAnimation(name);
				if (anim == null) continue;
				int frames = Math.Max(1, (int)Math.Round(anim.Duration * fps));
				float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
				for (int k2 = 0; k2 < frames; k2++) {
					Pose(skeleton, anim, k2 / fps, k2 == 0, 1f / fps);
					float bx, by, bw, bh;
					skeleton.GetBounds(out bx, out by, out bw, out bh, ref buffer);
					minX = Math.Min(minX, bx); minY = Math.Min(minY, by); maxX = Math.Max(maxX, bx + bw); maxY = Math.Max(maxY, by + bh);
				}
				int w = Math.Max(8, (int)Math.Ceiling((maxX - minX) * pxPerUnit)), h = Math.Max(8, (int)Math.Ceiling((maxY - minY) * pxPerUnit));
				var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
				cam.targetTexture = rt;
				cam.orthographicSize = (maxY - minY) * k / 2f;
				cam.aspect = (float)w / h;
				camGo.transform.position = new Vector3((minX + maxX) / 2f * k, (minY + maxY) / 2f * k, -100f);
				string outDir = Path.Combine(renderDir, RenderFolder(name), sub);
				Directory.CreateDirectory(outDir);
				var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
				for (int k2 = 0; k2 < frames; k2++) {
					Pose(skeleton, anim, k2 / fps, k2 == 0, 1f / fps);
					graphic.LateUpdate();
					Canvas.ForceUpdateCanvases();
					RenderCamera(cam, rt);
					RenderTexture.active = rt;
					tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
					tex.Apply();
					File.WriteAllBytes(Path.Combine(outDir, "frame_" + k2.ToString("000") + ".png"), tex.EncodeToPNG());
				}
				RenderTexture.active = null;
				cam.targetTexture = null;
				rt.Release();
			}
		};
		shoot("");
		if (groupAlpha <= 0f) return;
		// The reference: every part faded on its own, as a CanvasGroup does, through the SkeletonGraphic's own colour
		// (multiplied into the vertex colours the way the material expects).
		graphic.color = new Color(1f, 1f, 1f, groupAlpha);
		shoot("canvas-group-reference");
		graphic.color = Color.white;
		// Faded through a CanvasGroup: first with the settings detected without one (a fade added later), then with
		// spine-unity's Detect Settings run below it, in its order (tint black, CanvasGroup Compatible, PMA vertex
		// colors, material, blend mode materials).
		Func<string> settings = () => "canvasGroupCompatible=" + graphic.MeshSettings.canvasGroupCompatible + ", pmaVertexColors=" + graphic.MeshSettings.pmaVertexColors + ", tintBlack=" + graphic.MeshSettings.tintBlack + ", material=" + (graphic.material != null ? graphic.material.name : "none");
		graphicSettingsAsIs = settings();
		var group = canvasGo.AddComponent<CanvasGroup>();
		group.alpha = groupAlpha;
		shoot("canvas-group-as-is");
		SkeletonGraphicUtility.DetectTintBlack(graphic);
		SkeletonGraphicUtility.DetectCanvasGroupCompatible(graphic);
		SkeletonGraphicUtility.DetectPMAVertexColors(graphic);
		SkeletonGraphicUtility.DetectMaterial(graphic);
		SkeletonGraphicUtility.DetectBlendModeMaterials(graphic);
		graphicSettingsDetected = settings();
		shoot("canvas-group-detected");
	}

	/// <summary>Frame k of a sequential playback like Spine's renderer: physics reset at frame 0, then stepped.</summary>
	static void Pose (Skeleton skeleton, Spine.Animation anim, float t, bool first, float dt) {
		if (!first) skeleton.Update(dt);
		skeleton.SetupPose();
		anim.Apply(skeleton, t, t, false, null, 1f, MixFrom.Setup, false, false, false);
		skeleton.UpdateWorldTransform(first ? Spine.Physics.Reset : Spine.Physics.Update);
	}

	/// <summary>
	/// Animator transitions played through spine-unity's own SkeletonMecanim (the generated controller, one state per
	/// animation; layer 0's MixMode and autoReset from the spec, default MixNext and on): the Animator is stepped by hand
	/// at fps and the translator applies its state the way SkeletonMecanim does each frame.
	/// spec: "from>to>transitionSeconds>switchAtSeconds>totalSeconds[>MixMode>autoReset]|...".
	/// Bone world transforms per frame in Spine units, for comparison with spine-core.
	/// </summary>
	static string MecanimTransitions (SkeletonDataAsset asset, string spec, float fps, List<string> errors) {
		SkeletonBaker.GenerateMecanimAnimationClips(asset);
		// spine-unity generates one clip per animation; the states are the user's. Here: one looping state per clip on
		// layer 0, named after the animation, as a typical controller has them.
		var controller = (UnityEditor.Animations.AnimatorController)asset.controller;
		var stateMachine = controller.layers[0].stateMachine;
		foreach (AnimationClip clip in AssetDatabase.LoadAllAssetsAtPath(AssetDatabase.GetAssetPath(controller)).OfType<AnimationClip>()) {
			AnimationClipSettings settings = AnimationUtility.GetAnimationClipSettings(clip);
			settings.loopTime = true;
			AnimationUtility.SetAnimationClipSettings(clip, settings);
			if (!stateMachine.states.Any(st => st.state.name == clip.name)) controller.AddMotion(clip, 0);
		}
		AssetDatabase.SaveAssets();
		var sb = new StringBuilder("[");
		bool firstItem = true;
		foreach (string item in spec.Split('|')) {
			string[] p = item.Split('>');
			string from = p[0], to = p[1];
			float duration = float.Parse(p[2], CultureInfo.InvariantCulture), switchAt = float.Parse(p[3], CultureInfo.InvariantCulture), seconds = float.Parse(p[4], CultureInfo.InvariantCulture);
			SkeletonMecanim mecanim = EditorInstantiation.InstantiateSkeletonMecanim(asset, (Skin)null);
			try {
				Animator animator = mecanim.GetComponent<Animator>();
				animator.runtimeAnimatorController = asset.controller;
				mecanim.InitializeAnimationComponent();
				if (p.Length > 5) {
					mecanim.Translator.useCustomMixMode = true;
					mecanim.Translator.layerMixModes = new[] { (SkeletonMecanim.MecanimTranslator.MixMode)Enum.Parse(typeof(SkeletonMecanim.MecanimTranslator.MixMode), p[5]) };
				}
				if (p.Length > 6) mecanim.Translator.autoReset = p[6] == "1";
				Skeleton skeleton = mecanim.GetComponent<SkeletonRenderer>().Skeleton;
				skeleton.SetupPose();
				animator.Rebind();
				animator.Play(from, 0, 0f);
				float dt = 1f / fps;
				int total = (int)Math.Round(seconds * fps), switchFrame = (int)Math.Round(switchAt * fps);
				if (!firstItem) sb.Append(',');
				firstItem = false;
				sb.Append("{\"from\":").Append(Q(from)).Append(",\"to\":").Append(Q(to)).Append(",\"frames\":[");
				for (int k = 0; k <= total; k++) {
					if (k == switchFrame) animator.CrossFadeInFixedTime(to, duration, 0, 0f);
					animator.Update(k == 0 ? 0f : dt);
					mecanim.Translator.GatherAnimatorState();
					mecanim.Translator.Apply(skeleton);
					skeleton.UpdateWorldTransform(Spine.Physics.None);
					if (k > 0) sb.Append(',');
					sb.Append('[');
					bool firstBone = true;
					foreach (Bone bone in skeleton.Bones) {
						BonePose bp = bone.AppliedPose;
						if (!firstBone) sb.Append(',');
						firstBone = false;
						sb.Append(F(bp.WorldX)).Append(',').Append(F(bp.WorldY)).Append(',').Append(F(bp.WorldRotationX));
					}
					sb.Append(']');
				}
				sb.Append("]");
				sb.Append("}");
			} catch (Exception e) {
				errors.Add("mecanim " + from + " -> " + to + ": " + e);
			} finally {
				UnityEngine.Object.DestroyImmediate(mecanim.gameObject);
			}
		}
		return sb.Append(']').ToString();
	}

	/// <summary>
	/// Draw calls as spine-unity's SkeletonRenderer makes them: the submesh instructions MeshGenerator builds from the
	/// draw order each frame (a new submesh, so a new draw call, wherever the material changes: atlas page, blend mode
	/// material, clipping). Per animation the frame with the most, and where its submeshes split.
	/// </summary>
	static string Batching (string dir, string animationList, float fps) {
		string guid = AssetDatabase.FindAssets("t:SkeletonDataAsset", new[] { dir })[0];
		var asset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(guid));
		var components = NewSkeletonAnimation(asset);
		SkeletonRenderer renderer = components.skeletonRenderer;
		renderer.Initialize(true);
		Skeleton skeleton = renderer.Skeleton;
		var instruction = new SkeletonRendererInstruction();
		var names = string.IsNullOrEmpty(animationList) ? skeleton.Data.Animations.Select(a => a.Name).ToArray() : animationList.Split('|');
		var sb = new StringBuilder("[");
		bool first = true;
		Action<string, Spine.Animation> measure = (name, anim) => {
			int frames = anim == null ? 1 : Math.Max(1, (int)Math.Round(anim.Duration * fps));
			int worst = -1; float worstTime = 0; string worstSplit = "";
			for (int k = 0; k < frames; k++) {
				skeleton.SetupPose();
				if (anim != null) anim.Apply(skeleton, k / fps, k / fps, false, null, 1f, MixFrom.Setup, false, false, false);
				skeleton.UpdateWorldTransform(Spine.Physics.None);
				MeshGenerator.GenerateSkeletonRendererInstruction(instruction, skeleton, null, null, false);
				int count = instruction.submeshInstructions.Count;
				if (count > worst) {
					worst = count; worstTime = k / fps;
					var drawOrder = skeleton.DrawOrder.AppliedPose.Items;
					var parts = new List<string>();
					for (int i = 0; i < count; i++) {
						SubmeshInstruction si = instruction.submeshInstructions.Items[i];
						string startSlot = si.startSlot < skeleton.DrawOrder.AppliedPose.Count ? drawOrder[si.startSlot].Data.Name : "";
						string endSlot = si.endSlot - 1 >= 0 && si.endSlot - 1 < skeleton.DrawOrder.AppliedPose.Count ? drawOrder[si.endSlot - 1].Data.Name : "";
						parts.Add("{\"material\":" + Q(si.material != null ? si.material.name : "none") + ",\"from\":" + Q(startSlot) + ",\"to\":" + Q(endSlot) + ",\"slots\":" + si.SlotCount + ",\"clipping\":" + (si.hasClipping ? "true" : "false") + "}");
					}
					worstSplit = string.Join(",", parts);
				}
			}
			if (!first) sb.Append(',');
			first = false;
			sb.Append("{\"animation\":").Append(Q(name)).Append(",\"drawCalls\":").Append(worst).Append(",\"at\":").Append(F(worstTime)).Append(",\"submeshes\":[").Append(worstSplit).Append("]}");
		};
		measure("(setup pose)", null);
		foreach (string name in names) {
			Spine.Animation anim = skeleton.Data.FindAnimation(name);
			if (anim != null) measure(name, anim);
		}
		UnityEngine.Object.DestroyImmediate(components.skeletonRenderer.gameObject);
		return sb.Append(']').ToString();
	}

	/// <summary>
	/// Layered playback as a game runs it: SkeletonAnimation's AnimationState with one looping animation per track
	/// (track 0 first), stepped at fps for the given seconds. Physics off so spine-core can be compared frame by frame, or
	/// on as SkeletonAnimation runs it (Skeleton.Update, then the pose, then Physics.Update). Bone world transforms per
	/// frame in Spine units.
	/// </summary>
	static string Tracks (SkeletonDataAsset asset, string list, float seconds, float fps, bool physics, List<string> errors) {
		var components = NewSkeletonAnimation(asset);
		SkeletonAnimation sa = components.skeletonAnimation;
		sa.Initialize(true);
		Skeleton skeleton = components.skeletonRenderer.Skeleton;
		Spine.AnimationState state = sa.AnimationState;
		state.ClearTracks();
		skeleton.SetupPose();
		string[] names = list.Split('|');
		for (int i = 0; i < names.Length; i++) {
			if (skeleton.Data.FindAnimation(names[i]) == null) { errors.Add("tracks: animation not found: " + names[i]); return "[]"; }
			state.SetAnimation(i, names[i], true);
		}
		var sb = new StringBuilder("[");
		float dt = 1f / fps;
		int total = (int)Math.Round(seconds * fps);
		for (int k = 0; k <= total; k++) {
			if (k > 0) {
				if (physics) skeleton.Update(dt);
				state.Update(dt);
			}
			state.Apply(skeleton);
			skeleton.UpdateWorldTransform(physics ? Spine.Physics.Update : Spine.Physics.None);
			if (k > 0) sb.Append(',');
			sb.Append('[');
			bool firstBone = true;
			foreach (Bone bone in skeleton.Bones) {
				BonePose bp = bone.AppliedPose;
				if (!firstBone) sb.Append(',');
				firstBone = false;
				sb.Append(F(bp.WorldX)).Append(',').Append(F(bp.WorldY)).Append(',').Append(F(bp.WorldRotationX));
			}
			sb.Append(']');
		}
		UnityEngine.Object.DestroyImmediate(components.skeletonAnimation.gameObject);
		return sb.Append(']').ToString();
	}

	/// <summary>
	/// Folder name for an animation's renders, the same as renderFolder in src/platform.ts: a plain name (letters,
	/// digits, _ . -, up to 60, not ending in a dot) as it is, anything else as the hex of its UTF-8 bytes; hex longer
	/// than 120 keeps its first 88 digits plus "-" and the first 16 of the name's SHA-1.
	/// </summary>
	public static string RenderFolder (string name) {
		bool plain = name.Length > 0 && name.Length <= 60 && !name.EndsWith(".");
		foreach (char c in name) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-')) plain = false;
		if (plain) return name;
		var hex = new StringBuilder("x");
		foreach (byte b in Encoding.UTF8.GetBytes(name)) hex.Append(b.ToString("x2"));
		if (hex.Length <= 121) return hex.ToString();
		var sha = new StringBuilder();
		using (var sha1 = System.Security.Cryptography.SHA1.Create())
			foreach (byte b in sha1.ComputeHash(Encoding.UTF8.GetBytes(name))) sha.Append(b.ToString("x2"));
		return hex.ToString(0, 89) + "-" + sha.ToString(0, 16);
	}

	public static SkeletonComponents<SkeletonRenderer, SkeletonAnimation> NewSkeletonAnimation (SkeletonDataAsset asset) {
		var go = new GameObject("New Spine GameObject");
		go.SetActive(false);
		var renderer = go.AddComponent<SkeletonRenderer>();
		renderer.skeletonDataAsset = asset;
		var animation = go.AddComponent<SkeletonAnimation>();
		var serialized = new SerializedObject(animation);
		var transferred = serialized.FindProperty("wasDeprecatedTransferred");
		if (transferred != null) {
			transferred.boolValue = true;
			serialized.ApplyModifiedPropertiesWithoutUndo();
		}
		go.SetActive(true);
		renderer.Initialize(false, true);
		animation.Initialize(false, true);
		renderer.Animation = animation;
		return new SkeletonComponents<SkeletonRenderer, SkeletonAnimation>(renderer, animation);
	}

	public static string Arg (string name) {
		string[] a = Environment.GetCommandLineArgs();
		int i = Array.IndexOf(a, name);
		return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
	}

	// NaN and infinity are not JSON: a simulation that blew up reads as null (non-finite) on the TypeScript side.
	public static string F (float v) { return float.IsNaN(v) || float.IsInfinity(v) ? "null" : v.ToString("R", CultureInfo.InvariantCulture); }
	public static string Q (string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "") + "\""; }

	/// <summary>Imports the files in dir with spine-unity and returns the SkeletonDataAsset GUIDs found there.</summary>
	public static string[] ImportDir (string dir) {
		AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
		string[] guids = AssetDatabase.FindAssets("t:SkeletonDataAsset", new[] { dir });
		if (guids.Length == 0) {
			// The importer defers when the asset database was not ready at startup; run it directly.
			string[] files = Directory.GetFiles(dir).Where(f => !f.EndsWith(".meta")).Select(f => f.Replace('\\', '/')).ToArray();
			AssetUtility.ImportSpineContent(files, new List<string>());
			AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
			guids = AssetDatabase.FindAssets("t:SkeletonDataAsset", new[] { dir });
		}
		return guids;
	}

	/// <summary>One skeleton's report entry: counts plus every animation sampled at exact float times. World positions
	/// are multiplied by unitScale (1 / asset.scale gives Spine units without changing the asset).</summary>
	public static void AppendSkeleton (StringBuilder json, string path, SkeletonDataAsset asset, int samples, float unitScale, List<string> errors) {
		SkeletonData data = asset.GetSkeletonData(false);
		json.Append("{\"asset\":").Append(Q(path));
		json.Append(",\"atlases\":").Append(asset.atlasAssets.Count(a => a != null));
		json.Append(",\"materials\":").Append(asset.atlasAssets.Where(a => a != null).Sum(a => a.MaterialCount));
		if (data == null) {
			json.Append(",\"loaded\":false}");
			errors.Add("SkeletonData failed to load: " + path);
			return;
		}
		json.Append(",\"loaded\":true,\"bones\":[").Append(string.Join(",", data.Bones.Select(b => Q(b.Name)))).Append(']');
		json.Append(",\"slots\":").Append(data.Slots.Count);
		json.Append(",\"animations\":[");
		var skeleton = new Skeleton(data);
		bool firstAnim = true;
		foreach (Spine.Animation anim in data.Animations) {
			if (!firstAnim) json.Append(',');
			firstAnim = false;
			json.Append("{\"name\":").Append(Q(anim.Name)).Append(",\"duration\":").Append(F(anim.Duration));
			// The exact float times are reported so spine-core can sample the very same instants (keys are floats).
			var times = new float[samples + 1];
			for (int k = 0; k <= samples; k++) times[k] = anim.Duration * k / samples;
			json.Append(",\"times\":[").Append(string.Join(",", times.Select(F))).Append("],\"frames\":[");
			for (int k = 0; k <= samples; k++) {
				float t = times[k];
				skeleton.SetupPose();
				anim.Apply(skeleton, t, t, false, null, 1f, MixFrom.Setup, false, false, false);
				skeleton.UpdateWorldTransform(Spine.Physics.None);
				if (k > 0) json.Append(',');
				json.Append('[');
				bool firstBone = true;
				foreach (Bone bone in skeleton.Bones) {
					BonePose p = bone.AppliedPose;
					if (!firstBone) json.Append(',');
					firstBone = false;
					json.Append(F(p.WorldX * unitScale)).Append(',').Append(F(p.WorldY * unitScale)).Append(',').Append(F(p.WorldRotationX));
				}
				json.Append(']');
			}
			json.Append("]}");
		}
		json.Append("]}");
	}

	public static void Run () {
		string dir = Arg("-spineMcpDir"), output = Arg("-spineMcpOut");
		int samples = int.Parse(Arg("-spineMcpSamples") ?? "20", CultureInfo.InvariantCulture);
		var errors = new List<string>();
		var warnings = new List<string>();
		Application.LogCallback log = (msg, stack, type) => {
			if (type == LogType.Error || type == LogType.Exception) errors.Add(msg);
			else if (type == LogType.Warning && msg.Contains("Spine")) warnings.Add(msg);
		};
		Application.logMessageReceived += log;
		var json = new StringBuilder();
		json.Append("{\"unityVersion\":").Append(Q(Application.unityVersion));
		var pkg = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(SkeletonDataAsset).Assembly);
		json.Append(",\"spineUnityVersion\":").Append(pkg != null ? Q(pkg.version) : "null");
		json.Append(",\"skeletons\":[");
		string colorSpace = Arg("-spineMcpColorSpace"), workflow = Arg("-spineMcpWorkflow");
		string mecanimJson = null, tracksJson = null;
		bool urp = Arg("-spineMcpUrp") != null, urpShaders = Arg("-spineMcpUrpShaders") != null;
		try {
			if (urp) EnsureUrp(warnings);
			// Colour space and texture workflow only change in the dedicated project spine-mcp keeps per colour space.
			if (colorSpace == "linear" && PlayerSettings.colorSpace != ColorSpace.Linear) {
				PlayerSettings.colorSpace = ColorSpace.Linear;
				AssetDatabase.SaveAssets();
			}
			if (workflow != null) SetWorkflow(workflow == "straight");
			string[] guids = ImportDir(dir);
			if (guids.Length == 0) errors.Add("spine-unity did not create a SkeletonDataAsset in " + dir);
			if (workflow != null) {
				// What "Switch Texture Workflow" + Reimport does: spine-unity's texture preset on every atlas page, and for
				// straight alpha the material side too ("Straight Alpha Texture").
				bool straight = workflow == "straight";
				string presetName = straight ? "StraightAlphaPreset" : "PMATexturePreset";
				Preset preset = AssetDatabase.FindAssets(presetName + " t:Preset").Select(g => AssetDatabase.LoadAssetAtPath<Preset>(AssetDatabase.GUIDToAssetPath(g))).FirstOrDefault(x => x != null && x.name == presetName);
				if (preset == null) warnings.Add("spine-unity texture preset not found: " + presetName);
				foreach (string g in guids) {
					var a = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(g));
					foreach (var atlas in a.atlasAssets.Where(x => x != null))
						foreach (var m in atlas.Materials.Where(x => x != null)) {
							if (m.HasProperty("_StraightAlphaInput")) m.SetFloat("_StraightAlphaInput", straight ? 1f : 0f);
							if (straight) m.EnableKeyword("_STRAIGHT_ALPHA_INPUT"); else m.DisableKeyword("_STRAIGHT_ALPHA_INPUT");
							EditorUtility.SetDirty(m);
							AssetDatabase.SaveAssets();
							var ti = m.mainTexture != null ? AssetImporter.GetAtPath(AssetDatabase.GetAssetPath(m.mainTexture)) as TextureImporter : null;
							if (ti != null && preset != null && preset.ApplyTo(ti)) ti.SaveAndReimport();
						}
				}
				AssetDatabase.SaveAssets();
			}
			if (urp && urpShaders) {
				// What a URP project does with spine-unity: the atlas materials switched to the URP Spine shader.
				Shader shader = Shader.Find("Universal Render Pipeline/Spine/Skeleton");
				if (shader == null) errors.Add("URP Spine shader not found (com.esotericsoftware.spine.urp-shaders)");
				else foreach (string g in guids) {
					var a = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(g));
					foreach (var atlas in a.atlasAssets.Where(x => x != null))
						foreach (var m in atlas.Materials.Where(x => x != null)) {
							float straight = m.HasProperty("_StraightAlphaInput") ? m.GetFloat("_StraightAlphaInput") : 0f;
							m.shader = shader;
							if (m.HasProperty("_StraightAlphaInput")) m.SetFloat("_StraightAlphaInput", straight);
							EditorUtility.SetDirty(m);
						}
				}
				AssetDatabase.SaveAssets();
			}
			bool firstSkeleton = true;
			foreach (string guid in guids) {
				string path = AssetDatabase.GUIDToAssetPath(guid);
				var asset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(path);
				asset.scale = 1f; // compare in Spine units (spine-unity defaults to 0.01)
				asset.Clear();
				if (!firstSkeleton) json.Append(',');
				firstSkeleton = false;
				AppendSkeleton(json, path, asset, samples, 1f, errors);
			}
			string trackList = Arg("-spineMcpTracks");
			if (trackList != null && guids.Length > 0) {
				var trackAsset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(guids[0]));
				tracksJson = Tracks(trackAsset, trackList, float.Parse(Arg("-spineMcpTracksSeconds") ?? "10", CultureInfo.InvariantCulture), float.Parse(Arg("-spineMcpTracksFps") ?? "30", CultureInfo.InvariantCulture), Arg("-spineMcpTracksPhysics") == "1", errors);
			}
			string mecanimSpec = Arg("-spineMcpMecanim");
			if (mecanimSpec != null && guids.Length > 0) {
				var mecanimAsset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(guids[0]));
				mecanimJson = MecanimTransitions(mecanimAsset, mecanimSpec, float.Parse(Arg("-spineMcpMecanimFps") ?? "60", CultureInfo.InvariantCulture), errors);
			}
		} catch (Exception e) {
			errors.Add(e.ToString());
		}
		string batchingJson = null;
		if (Arg("-spineMcpBatching") != null && errors.Count == 0) {
			try {
				string batchingList = Arg("-spineMcpBatching");
				batchingJson = Batching(dir, batchingList == "*" ? null : batchingList, float.Parse(Arg("-spineMcpBatchingFps") ?? "10", CultureInfo.InvariantCulture));
			} catch (Exception e) {
				errors.Add("batching: " + e);
			}
		}
		string renderDir = Arg("-spineMcpRenderDir");
		if (renderDir != null && errors.Count == 0) {
			try {
				if (Arg("-spineMcpRenderGraphic") != null) RenderGraphicFrames(dir, renderDir, Arg("-spineMcpRenderAnimations"), float.Parse(Arg("-spineMcpRenderFps") ?? "30", CultureInfo.InvariantCulture), float.Parse(Arg("-spineMcpRenderScale") ?? "50", CultureInfo.InvariantCulture), float.Parse(Arg("-spineMcpCanvasGroup") ?? "0", CultureInfo.InvariantCulture));
				else RenderFrames(dir, renderDir, Arg("-spineMcpRenderAnimations"), float.Parse(Arg("-spineMcpRenderFps") ?? "30", CultureInfo.InvariantCulture), float.Parse(Arg("-spineMcpRenderScale") ?? "50", CultureInfo.InvariantCulture));
			} catch (Exception e) {
				errors.Add("render: " + e);
			}
		}
		string compressionJson = null;
		string compressionSpec = Arg("-spineMcpCompression");
		if (compressionSpec != null && errors.Count == 0) {
			try {
				compressionJson = Compression(dir, Arg("-spineMcpCompressionDir"), compressionSpec, Arg("-spineMcpCompressionAnimations"), float.Parse(Arg("-spineMcpCompressionFps") ?? "10", CultureInfo.InvariantCulture));
			} catch (Exception e) {
				errors.Add("compression: " + e);
			}
		}
		Application.logMessageReceived -= log;
		// Texture import and material settings as spine-unity left them (they decide how Linear looks).
		var tex = TextureReport(dir, warnings);
		json.Append("],\"textures\":[").Append(string.Join(",", tex)).Append(']');
		var pipeline = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline;
		json.Append(",\"renderPipeline\":").Append(Q(pipeline != null ? pipeline.GetType().Name : "built-in"));
		if (graphicSettingsDetected != null) json.Append(",\"canvasGroup\":{\"asIs\":").Append(Q(graphicSettingsAsIs)).Append(",\"detected\":").Append(Q(graphicSettingsDetected)).Append('}');
		json.Append(",\"colorSpace\":").Append(Q(PlayerSettings.colorSpace.ToString())).Append(",\"workflow\":").Append(workflow != null ? Q(workflow) : "null");
		if (mecanimJson != null) json.Append(",\"mecanim\":").Append(mecanimJson);
		if (batchingJson != null) json.Append(",\"batching\":").Append(batchingJson);
		if (tracksJson != null) json.Append(",\"tracks\":").Append(tracksJson);
		if (compressionJson != null) json.Append(",\"compression\":").Append(compressionJson);
		json.Append(",\"errors\":[").Append(string.Join(",", errors.Select(Q))).Append(']');
		json.Append(",\"warnings\":[").Append(string.Join(",", warnings.Distinct().Select(Q))).Append("]}");
		File.WriteAllText(output, json.ToString());
		EditorApplication.Exit(errors.Count == 0 ? 0 : 1);
	}

	/// <summary>
	/// Device texture compression (run with -buildTarget Android): every atlas page imported with an Android override of
	/// RGBA32 first (the baseline), then of each requested format, nothing else changed. Per format: each page's pixels
	/// read back from the GPU (texture level), frames rendered at 100% (what a player sees), and the format Unity
	/// actually loaded.
	/// </summary>
	static string Compression (string dir, string outDir, string formats, string animationList, float fps) {
		var pages = new List<string>();
		foreach (string g in AssetDatabase.FindAssets("t:SkeletonDataAsset", new[] { dir })) {
			var a = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(g));
			foreach (var atlas in a.atlasAssets.Where(x => x != null))
				foreach (var m in atlas.Materials.Where(x => x != null && x.mainTexture != null)) {
					string p = AssetDatabase.GetAssetPath(m.mainTexture);
					if (!pages.Contains(p)) pages.Add(p);
				}
		}
		var list = new List<string> { "RGBA32" };
		list.AddRange(formats.Split('|').Where(f => f != "RGBA32"));
		var sb = new StringBuilder("[");
		for (int i = 0; i < list.Count; i++) {
			var format = (TextureImporterFormat)Enum.Parse(typeof(TextureImporterFormat), list[i]);
			string formatDir = Path.Combine(outDir, list[i]);
			Directory.CreateDirectory(Path.Combine(formatDir, "~pages"));
			if (i > 0) sb.Append(',');
			sb.Append("{\"format\":").Append(Q(list[i])).Append(",\"pages\":[");
			for (int k = 0; k < pages.Count; k++) {
				var ti = (TextureImporter)AssetImporter.GetAtPath(pages[k]);
				int sw, sh;
				ti.GetSourceTextureWidthAndHeight(out sw, out sh);
				var ps = ti.GetPlatformTextureSettings("Android");
				int size = 32;
				while (size < Math.Max(sw, sh)) size *= 2;
				ps.overridden = true;
				ps.format = format;
				ps.maxTextureSize = Math.Max(ps.maxTextureSize, Math.Min(size, 16384));
				ti.SetPlatformTextureSettings(ps);
				ti.SaveAndReimport();
				var t = AssetDatabase.LoadAssetAtPath<Texture2D>(pages[k]);
				var rt = RenderTexture.GetTemporary(t.width, t.height, 0, RenderTextureFormat.ARGB32);
				Graphics.Blit(t, rt);
				var previous = RenderTexture.active;
				RenderTexture.active = rt;
				var read = new Texture2D(t.width, t.height, TextureFormat.RGBA32, false);
				read.ReadPixels(new Rect(0, 0, t.width, t.height), 0, 0);
				read.Apply();
				RenderTexture.active = previous;
				RenderTexture.ReleaseTemporary(rt);
				File.WriteAllBytes(Path.Combine(formatDir, "~pages", k.ToString("00") + ".png"), read.EncodeToPNG());
				UnityEngine.Object.DestroyImmediate(read);
				if (k > 0) sb.Append(',');
				sb.Append("{\"texture\":").Append(Q(pages[k])).Append(",\"loaded\":").Append(Q(t.format.ToString()))
					.Append(",\"supported\":").Append(SystemInfo.SupportsTextureFormat(t.format) ? "true" : "false")
					.Append(",\"size\":[").Append(t.width).Append(',').Append(t.height).Append("]}");
			}
			sb.Append("]}");
			RenderFrames(dir, formatDir, animationList, fps, 100f);
		}
		return sb.Append(']').ToString();
	}

	/// <summary>
	/// A URP pipeline asset (with a renderer) created and assigned once, by reflection so this script still compiles in
	/// projects without URP.
	/// </summary>
	static void EnsureUrp (List<string> warnings) {
		if (UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline != null) return;
		Type assetType = Type.GetType("UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset, Unity.RenderPipelines.Universal.Runtime");
		Type rendererType = Type.GetType("UnityEngine.Rendering.Universal.UniversalRendererData, Unity.RenderPipelines.Universal.Runtime");
		if (assetType == null || rendererType == null) throw new Exception("URP is not installed in this project");
		if (!AssetDatabase.IsValidFolder("Assets/URP")) AssetDatabase.CreateFolder("Assets", "URP");
		var rendererData = ScriptableObject.CreateInstance(rendererType);
		AssetDatabase.CreateAsset(rendererData, "Assets/URP/Renderer.asset");
		var create = assetType.GetMethod("Create", new[] { Type.GetType("UnityEngine.Rendering.Universal.ScriptableRendererData, Unity.RenderPipelines.Universal.Runtime") });
		var asset = (UnityEngine.Rendering.RenderPipelineAsset)create.Invoke(null, new object[] { rendererData });
		AssetDatabase.CreateAsset(asset, "Assets/URP/URP.asset");
		UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline = asset;
		for (int i = 0; i < QualitySettings.names.Length; i++) { QualitySettings.SetQualityLevel(i, false); QualitySettings.renderPipeline = asset; }
		AssetDatabase.SaveAssets();
	}

	/// <summary>Renders a camera into a texture: a standard render request under a render pipeline (URP has no Camera.Render), else Camera.Render.</summary>
	static void RenderCamera (Camera cam, RenderTexture rt) {
		if (UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null) {
			Type req = typeof(UnityEngine.Rendering.RenderPipeline).GetNestedType("StandardRequest");
			if (req != null) {
				object r = Activator.CreateInstance(req);
				req.GetField("destination").SetValue(r, rt);
				var submit = typeof(UnityEngine.Rendering.RenderPipeline).GetMethods().First(m => m.Name == "SubmitRenderRequest" && m.IsGenericMethodDefinition).MakeGenericMethod(req);
				submit.Invoke(null, new object[] { cam, r });
				return;
			}
		}
		cam.Render();
	}

	/// <summary>Every atlas page under a folder: material, shader and the texture import settings that decide how it looks and how big it ships.</summary>
	public static List<string> TextureReport (string dir, List<string> warnings) {
		var tex = new List<string>();
		try {
			foreach (string g in AssetDatabase.FindAssets("t:SkeletonDataAsset", new[] { dir })) {
				var a = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(AssetDatabase.GUIDToAssetPath(g));
				foreach (var atlas in a.atlasAssets.Where(x => x != null))
					foreach (var m in atlas.Materials.Where(x => x != null)) {
						var t = m.mainTexture;
						var ti = t != null ? AssetImporter.GetAtPath(AssetDatabase.GetAssetPath(t)) as TextureImporter : null;
						var sb = new StringBuilder();
						sb.Append("{\"material\":").Append(Q(m.name)).Append(",\"shader\":").Append(Q(m.shader.name))
							.Append(",\"straightAlphaInput\":").Append(m.HasProperty("_StraightAlphaInput") ? F(m.GetFloat("_StraightAlphaInput")) : "null")
							.Append(",\"sRGB\":").Append(ti != null ? (ti.sRGBTexture ? "true" : "false") : "null")
							.Append(",\"alphaIsTransparency\":").Append(ti != null ? (ti.alphaIsTransparency ? "true" : "false") : "null");
						if (ti != null) {
							int sw, sh;
							ti.GetSourceTextureWidthAndHeight(out sw, out sh);
							sb.Append(",\"texture\":").Append(Q(AssetDatabase.GetAssetPath(t))).Append(",\"source\":[").Append(sw).Append(',').Append(sh).Append(']')
								.Append(",\"maxTextureSize\":").Append(ti.maxTextureSize).Append(",\"mipmaps\":").Append(ti.mipmapEnabled ? "true" : "false")
								.Append(",\"filter\":").Append(Q(ti.filterMode.ToString())).Append(",\"compression\":").Append(Q(ti.textureCompression.ToString()))
								.Append(",\"platforms\":{");
							bool first = true;
							foreach (string platform in new[] { "Android", "iPhone", "WebGL", "Standalone" }) {
								var ps = ti.GetPlatformTextureSettings(platform);
								if (!first) sb.Append(',');
								first = false;
								sb.Append(Q(platform)).Append(":{\"overridden\":").Append(ps.overridden ? "true" : "false").Append(",\"maxTextureSize\":").Append(ps.maxTextureSize).Append(",\"format\":").Append(Q(ps.format.ToString())).Append('}');
							}
							sb.Append('}');
						}
						tex.Add(sb.Append('}').ToString());
					}
			}
		} catch (Exception e) { warnings.Add("texture settings: " + e.Message); }
		return tex;
	}

	/// <summary>spine-unity's texture import presets for PMA or straight alpha (Preferences > Spine > Switch Texture Workflow).</summary>
	static void SetWorkflow (bool straight) {
		Type t = typeof(SkeletonDataAsset).Assembly.GetType("Spine.Unity.Editor.SpinePreferences") ?? AppDomain.CurrentDomain.GetAssemblies().Select(x => x.GetType("Spine.Unity.Editor.SpinePreferences")).FirstOrDefault(x => x != null);
		if (t == null) throw new Exception("spine-unity SpinePreferences not found");
		object settings = t.GetMethod("GetOrCreateSettings", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
		t.GetMethod(straight ? "SwitchToStraightAlphaDefaults" : "SwitchToPMADefaults", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null).Invoke(settings, null);
	}
}
