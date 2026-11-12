// Player-side CPU and GC measurement run by spine-mcp (spine_unity_check perf). Built once into a headless player per
// Unity version; each run loads exported Spine runtime files (JSON, atlas, PNG pages) from a folder at runtime.
// Invoked as: <player> -batchmode -nographics -spineMcpPerfDir /abs/data -spineMcpPerfOut /abs/report.json
//   -spineMcpPerfAnimations "walk|run" -spineMcpPerfCounts "1|10|50" -spineMcpPerfFrames 120 -spineMcpPerfWarmup 30
//   -spineMcpPerfModes "single|threaded"
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Spine.Unity;
using UnityEngine;
using UnityEngine.Profiling;
using UnityEngine.Scripting;

/// <summary>Frame markers before every other script's Update and LateUpdate.</summary>
[DefaultExecutionOrder(-32000)]
public class SpineMcpPerf : MonoBehaviour {
	internal static readonly Stopwatch Clock = Stopwatch.StartNew();
	internal static double UpdateStart, UpdateEnd, LateStart, LateEnd;
	static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

	void Awake () {
		gameObject.AddComponent<SpineMcpPerfEnd>();
	}

	void Update () { UpdateStart = Clock.Elapsed.TotalMilliseconds; }
	void LateUpdate () { LateStart = Clock.Elapsed.TotalMilliseconds; }

	static string Arg (string name) {
		string[] a = Environment.GetCommandLineArgs();
		int i = Array.IndexOf(a, name);
		return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
	}

	static string F (double v) { return double.IsNaN(v) || double.IsInfinity(v) ? "null" : v.ToString("0.#####", Inv); }
	static string Q (string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "").Replace("\t", " ") + "\""; }

	static string Stats (List<double> v) {
		if (v.Count == 0) return "null";
		var s = v.OrderBy(x => x).ToList();
		double median = s[s.Count / 2], p95 = s[Math.Min(s.Count - 1, (int)Math.Ceiling(s.Count * 0.95) - 1)];
		return "{\"median\":" + F(median) + ",\"p95\":" + F(p95) + ",\"mean\":" + F(v.Average()) + ",\"max\":" + F(s[s.Count - 1]) + "}";
	}

	IEnumerator Start () {
		var json = new StringBuilder();
		var errors = new List<string>();
		Application.logMessageReceived += (msg, stack, type) => {
			if (type == LogType.Error || type == LogType.Exception) errors.Add(msg);
		};
		string output = Arg("-spineMcpPerfOut");
		try {
			QualitySettings.vSyncCount = 0;
			Application.targetFrameRate = -1;
			Time.captureDeltaTime = 1f / 30f;
		} catch (Exception e) { errors.Add("setup: " + e.Message); }

		SkeletonDataAsset data = null;
		try { data = Load(Arg("-spineMcpPerfDir")); } catch (Exception e) { errors.Add("load: " + e); }

		int frames = int.Parse(Arg("-spineMcpPerfFrames") ?? "120", Inv), warmup = int.Parse(Arg("-spineMcpPerfWarmup") ?? "30", Inv);
		int[] counts = (Arg("-spineMcpPerfCounts") ?? "1|10|50").Split('|').Select(s => int.Parse(s, Inv)).ToArray();
		string[] modes = (Arg("-spineMcpPerfModes") ?? "single|threaded").Split('|');
		string[] animations = data == null ? new string[0] : (Arg("-spineMcpPerfAnimations") ?? data.GetSkeletonData(true).Animations.Items[0].Name).Split('|');
		string skin = Arg("-spineMcpPerfSkin");
		if (data != null && skin != null && data.GetSkeletonData(true).FindSkin(skin) == null) { errors.Add("skin not found: " + skin); data = null; }

		json.Append("{\"unityVersion\":").Append(Q(Application.unityVersion));
#if ENABLE_IL2CPP
		json.Append(",\"backend\":\"IL2CPP\"");
#else
		json.Append(",\"backend\":\"Mono\"");
#endif
		json.Append(",\"system\":{\"processor\":").Append(Q(SystemInfo.processorType)).Append(",\"cores\":").Append(SystemInfo.processorCount)
			.Append(",\"os\":").Append(Q(SystemInfo.operatingSystem)).Append(",\"graphics\":").Append(Q(SystemInfo.graphicsDeviceType.ToString())).Append('}');
		json.Append(",\"frames\":").Append(frames).Append(",\"warmup\":").Append(warmup);

		// Positive control: a known allocation per frame must come back as about that many bytes.
		var control = new List<Run>();
		yield return Measure(null, null, "", 0, "single", frames, warmup, 1000, control, errors);
		// Baseline: the player loop with no skeleton.
		var baseline = new List<Run>();
		yield return Measure(null, null, "", 0, "single", frames, warmup, 0, baseline, errors);

		var runs = new List<Run>();
		if (data != null) {
			foreach (string anim in animations)
				foreach (int count in counts)
					foreach (string mode in modes)
						yield return Measure(data, skin, anim, count, mode, frames, warmup, 0, runs, errors);
		}
		json.Append(",\"control\":").Append(control.Count > 0 ? control[0].Json() : "null");
		json.Append(",\"baseline\":").Append(baseline.Count > 0 ? baseline[0].Json() : "null");
		json.Append(",\"runs\":[").Append(string.Join(",", runs.Select(r => r.Json()))).Append(']');
		json.Append(",\"errors\":[").Append(string.Join(",", errors.Distinct().Take(20).Select(Q))).Append("]}");
		if (output != null) File.WriteAllText(output, json.ToString());
		Application.Quit(errors.Count == 0 ? 0 : 1);
	}

	class Run {
		public string animation, mode;
		public int count;
		// Sized up front: growing a list inside the measured window would count as the skeletons' garbage.
		public List<double> frame, update, late;
		public Run (int frames) { frame = new List<double>(frames); update = new List<double>(frames); late = new List<double>(frames); }
		public double gcBytesPerFrame;
		public int vertexMin = int.MaxValue, vertexMax;
		public bool meshChanged, systemPresent;
		public int registeredAnimations, registeredRenderers;
		public float poseX, poseY;
		public string Json () {
			return "{\"animation\":" + Q(animation) + ",\"count\":" + count + ",\"mode\":" + Q(mode)
				+ ",\"frameMs\":" + Stats(frame) + ",\"updateMs\":" + Stats(update) + ",\"lateUpdateMs\":" + Stats(late)
				+ ",\"gcBytesPerFrame\":" + F(gcBytesPerFrame)
				+ ",\"vertices\":" + (vertexMax > 0 ? "[" + vertexMin + "," + vertexMax + "]" : "null") + ",\"meshChanged\":" + (meshChanged ? "true" : "false")
				+ ",\"threadedSystem\":" + (systemPresent ? "true" : "false") + ",\"registered\":[" + registeredAnimations + "," + registeredRenderers + "]"
				+ ",\"pose\":[" + F(poseX) + "," + F(poseY) + "]}";
		}
	}

	/// <summary>Spawns count skeletons playing anim (start times staggered), warms up, then measures frames.</summary>
	IEnumerator Measure (SkeletonDataAsset data, string skin, string anim, int count, string mode, int frames, int warmup, int allocate, List<Run> into, List<string> errors) {
		bool threaded = mode == "threaded";
		RuntimeSettings.UseThreadedAnimation = threaded;
		RuntimeSettings.UseThreadedMeshGeneration = threaded;
		var spawned = new List<SkeletonComponents<SkeletonRenderer, SkeletonAnimation>>();
		var run = new Run(frames) { animation = anim, count = count, mode = mode };
		if (data != null) {
			var animation = data.GetSkeletonData(true).FindAnimation(anim);
			if (animation == null) { errors.Add("animation not found: " + anim); yield break; }
			float duration = Math.Max(animation.Duration, 1e-3f);
			for (int i = 0; i < count; i++) {
				var c = SkeletonAnimation.NewSkeletonAnimationGameObject(data, true);
				c.skeletonRenderer.updateWhenInvisible = UpdateMode.FullUpdate;
				if (skin != null) { c.skeletonRenderer.Skeleton.SetSkin(skin); c.skeletonRenderer.Skeleton.SetupPoseSlots(); }
				c.skeletonRenderer.transform.position = new Vector3((i % 10) * 3f, (i / 10) * 3f, 0);
				var entry = c.skeletonAnimation.AnimationState.SetAnimation(0, anim, true);
				entry.TrackTime = (i * 0.137f) % duration;
				spawned.Add(c);
			}
		}
		for (int k = 0; k < warmup; k++) yield return null;
		// The system hides itself (HideFlags.DontSave), so object searches miss it: read its singleton without creating one.
		var system = typeof(SkeletonUpdateSystem).GetField("singletonInstance", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)?.GetValue(null) as SkeletonUpdateSystem;
		run.systemPresent = system != null;
		if (system != null) { run.registeredAnimations = system.skeletonAnimationsUpdate.Count; run.registeredRenderers = system.skeletonRenderers.Count; }
		MeshFilter filter = spawned.Count > 0 ? spawned[0].skeletonRenderer.GetComponent<MeshFilter>() : null;
		Vector3 firstCenter = Vector3.zero;
		bool haveCenter = false;
		var sink = new List<byte[]>(frames);
		System.GC.Collect();
		UnityEngine.Scripting.GarbageCollector.GCMode = UnityEngine.Scripting.GarbageCollector.Mode.Disabled;
		long heapBefore = Profiler.GetMonoUsedSizeLong();
		double last = Clock.Elapsed.TotalMilliseconds;
		for (int k = 0; k < frames; k++) {
			if (allocate > 0) sink.Add(new byte[allocate]);
			yield return null;
			double now = Clock.Elapsed.TotalMilliseconds;
			run.frame.Add(now - last);
			last = now;
			run.update.Add(UpdateEnd - UpdateStart);
			if (k > 0) run.late.Add(LateEnd - LateStart);
			if (filter != null && filter.sharedMesh != null) {
				int v = filter.sharedMesh.vertexCount;
				run.vertexMin = Math.Min(run.vertexMin, v);
				run.vertexMax = Math.Max(run.vertexMax, v);
				Vector3 center = filter.sharedMesh.bounds.center;
				if (!haveCenter) { firstCenter = center; haveCenter = true; } else if ((center - firstCenter).sqrMagnitude > 1e-10f) run.meshChanged = true;
			}
		}
		long heapAfter = Profiler.GetMonoUsedSizeLong();
		UnityEngine.Scripting.GarbageCollector.GCMode = UnityEngine.Scripting.GarbageCollector.Mode.Enabled;
		run.gcBytesPerFrame = (heapAfter - heapBefore) / (double)frames;
		sink.Clear();
		if (spawned.Count > 0) {
			var bones = spawned[0].skeletonAnimation.Skeleton.Bones;
			var bone = bones.Items[bones.Count - 1].AppliedPose;
			run.poseX = bone.WorldX;
			run.poseY = bone.WorldY;
		}
		into.Add(run);
		foreach (var c in spawned) Destroy(c.skeletonRenderer.gameObject);
		yield return null;
		yield return null;
	}

	/// <summary>The exported JSON, atlas and PNG pages in a folder, as runtime assets with spine-unity's default material.</summary>
	static SkeletonDataAsset Load (string dir) {
		string atlasFile = Directory.GetFiles(dir, "*.atlas").First(), jsonFile = Directory.GetFiles(dir, "*.json").First();
		var atlasText = new TextAsset(File.ReadAllText(atlasFile)) { name = Path.GetFileNameWithoutExtension(atlasFile) };
		var textures = Directory.GetFiles(dir, "*.png").Select(f => {
			var t = new Texture2D(2, 2, TextureFormat.RGBA32, false) { name = Path.GetFileNameWithoutExtension(f) };
			t.LoadImage(File.ReadAllBytes(f));
			return t;
		}).ToArray();
		Material source = Resources.Load<Material>("SpineMcpPerfSkeleton");
		if (source == null) throw new Exception("Resources/SpineMcpPerfSkeleton material missing from the build");
		// Headless (-nographics) no shader counts as supported; it only has to be in the build for the material to exist.
		if (source.shader == null || source.shader.name != "Spine/Skeleton") throw new Exception("Spine/Skeleton shader not in the build");
		var atlas = SpineAtlasAsset.CreateRuntimeInstance(atlasText, textures, source, true);
		var skeletonText = new TextAsset(File.ReadAllText(jsonFile)) { name = Path.GetFileName(jsonFile) };
		var data = SkeletonDataAsset.CreateRuntimeInstance(skeletonText, atlas, true);
		if (data.GetSkeletonData(true) == null) throw new Exception("skeleton data did not load");
		return data;
	}
}

/// <summary>Frame markers after every other script's Update and LateUpdate.</summary>
[DefaultExecutionOrder(32000)]
public class SpineMcpPerfEnd : MonoBehaviour {
	void Update () { SpineMcpPerf.UpdateEnd = SpineMcpPerf.Clock.Elapsed.TotalMilliseconds; }
	void LateUpdate () { SpineMcpPerf.LateEnd = SpineMcpPerf.Clock.Elapsed.TotalMilliseconds; }
}
