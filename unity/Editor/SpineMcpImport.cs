// Batch-mode import run by spine-mcp (spine_unity_import) inside the user's Unity project: lets spine-unity import the
// runtime files, sets mix durations on the SkeletonDataAsset, optionally saves a SkeletonAnimation (or UI SkeletonGraphic) prefab, then reads
// everything back and samples the animations (Spine units) so spine-mcp can verify the result against spine-core.
// Invoked as: Unity -batchmode -nographics -projectPath P -executeMethod SpineMcpImport.Run
//   -spineMcpDir Assets/... -spineMcpOut /abs/report.json -spineMcpSettings /abs/settings.json [-spineMcpPrefab Assets/....prefab]
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Spine;
using Spine.Unity;
using UnityEditor;
using UnityEngine;

public static class SpineMcpImport {
	[Serializable]
	class Settings {
		public bool setDefaultMix;
		public float defaultMix;
		public bool setMixes;
		public string[] from = new string[0];
		public string[] to = new string[0];
		public float[] duration = new float[0];
		public string startingAnimation = "";
		public bool loop = true;
		public string skin = "";
		public int samples = 20;
		/// <summary>animation: SkeletonAnimation (world); graphic: SkeletonGraphic (UI, under a Canvas).</summary>
		public string component = "animation";
		/// <summary>One AnimationReferenceAsset per animation (in ReferenceAssets next to the data), as the SkeletonDataAsset inspector makes them.</summary>
		public bool referenceAssets;
		/// <summary>Bones that get a child GameObject following them (BoneFollower, or BoneFollowerGraphic for UI) on the prefab.</summary>
		public string[] followers = new string[0];
		public string textureType = "";
		public string spriteMode = "";
		public int sRGB = -1;
		public int alphaIsTransparency = -1;
		public int mipmaps = -1;
		public int maxSize;
		public string[] platformTargets = new string[0];
		public string[] platformFormats = new string[0];
		public int[] platformMaxSizes = new int[0];
		public bool spriteSlices;
		public int canvasGroupCompatible = -1;
		public int pmaVertexColors = -1;
		public string graphicMaterial = "";
		public bool straightAlpha;
	}

	public static void Run () {
		string dir = SpineMcpCheck.Arg("-spineMcpDir"), output = SpineMcpCheck.Arg("-spineMcpOut");
		string prefabPath = SpineMcpCheck.Arg("-spineMcpPrefab");
		var settings = JsonUtility.FromJson<Settings>(File.ReadAllText(SpineMcpCheck.Arg("-spineMcpSettings")));
		var errors = new List<string>();
		var warnings = new List<string>();
		bool addingFollowers = false;
		Application.LogCallback log = (msg, stack, type) => {
			// A new BoneFollower logs its 4.3 upgrade check before its renderer can be assigned (it is, right after).
			if (addingFollowers && msg.Contains("automatic upgrade failed")) return;
			if (type == LogType.Error || type == LogType.Exception) errors.Add(msg);
			else if (type == LogType.Warning && msg.Contains("Spine")) warnings.Add(msg);
		};
		Application.logMessageReceived += log;
		var json = new StringBuilder();
		json.Append("{\"unityVersion\":").Append(SpineMcpCheck.Q(Application.unityVersion));
		var pkg = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(SkeletonDataAsset).Assembly);
		json.Append(",\"spineUnityVersion\":").Append(pkg != null ? SpineMcpCheck.Q(pkg.version) : "null");
		string applied = "null", prefabReport = "null", team = "null";
		var references = new List<string>();
		json.Append(",\"skeletons\":[");
		try {
			string[] guids = SpineMcpCheck.ImportDir(dir);
			if (guids.Length == 0) throw new Exception("spine-unity did not create a SkeletonDataAsset in " + dir);
			string path = AssetDatabase.GUIDToAssetPath(guids[0]);
			var asset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(path);
			SkeletonData data = asset.GetSkeletonData(false);
			if (data == null) throw new Exception("SkeletonData failed to load: " + path);
			if (settings.straightAlpha) StraightMaterials(asset);
			team = ApplyTexture(asset, settings, errors);

			// Mixes: names are checked first so nothing half-valid is saved.
			if (settings.setMixes) {
				for (int i = 0; i < settings.from.Length; i++) {
					if (data.FindAnimation(settings.from[i]) == null) errors.Add("mix: animation not found: " + settings.from[i]);
					if (data.FindAnimation(settings.to[i]) == null) errors.Add("mix: animation not found: " + settings.to[i]);
				}
			}
			if (errors.Count == 0) {
				if (settings.setMixes) {
					asset.fromAnimation = settings.from;
					asset.toAnimation = settings.to;
					asset.duration = settings.duration;
				}
				if (settings.setDefaultMix) asset.defaultMix = settings.defaultMix;
				EditorUtility.SetDirty(asset);
				AssetDatabase.SaveAssets();
			}

			if (settings.referenceAssets && errors.Count == 0) {
				string folder = Path.GetDirectoryName(path).Replace('\\', '/') + "/ReferenceAssets";
				if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(Path.GetDirectoryName(path).Replace('\\', '/'), "ReferenceAssets");
				foreach (Spine.Animation a in data.Animations) {
					string refPath = folder + "/" + Spine.Unity.Editor.AssetUtility.GetPathSafeName(a.Name) + ".asset";
					if (AssetDatabase.LoadAssetAtPath<AnimationReferenceAsset>(refPath) == null) {
						var ra = ScriptableObject.CreateInstance<AnimationReferenceAsset>();
						ra.SkeletonDataAsset = asset;
						ra.AnimationName = a.Name;
						AssetDatabase.CreateAsset(ra, refPath);
					}
					references.Add(refPath);
				}
				AssetDatabase.SaveAssets();
			}

			if (!string.IsNullOrEmpty(prefabPath) && errors.Count == 0) {
				foreach (string b in settings.followers) if (data.FindBone(b) == null) errors.Add("follower bone not found: " + b);
				if (settings.startingAnimation.Length > 0 && data.FindAnimation(settings.startingAnimation) == null) errors.Add("startingAnimation not found: " + settings.startingAnimation);
				if (settings.skin.Length > 0 && data.FindSkin(settings.skin) == null) errors.Add("skin not found: " + settings.skin);
				if (errors.Count == 0) {
					GameObject go;
					SkeletonAnimation sa0;
					if (settings.component == "graphic") {
						// What GameObject > Spine > SkeletonGraphic (UI) does: RectTransform, CanvasRenderer, SkeletonGraphic + SkeletonAnimation,
						// then the material matching the texture workflow (PMA or straight) and the blend-mode materials.
						var graphic = Spine.Unity.Editor.EditorInstantiation.InstantiateSkeletonGraphic(asset, settings.skin.Length > 0 ? data.FindSkin(settings.skin) : null);
						if (graphic == null) throw new Exception("SkeletonGraphic could not be created from " + path);
						if (settings.canvasGroupCompatible >= 0) graphic.MeshSettings.canvasGroupCompatible = settings.canvasGroupCompatible == 1;
						if (settings.pmaVertexColors >= 0) graphic.MeshSettings.pmaVertexColors = settings.pmaVertexColors == 1;
						Spine.Unity.Editor.SkeletonGraphicUtility.DetectMaterial(graphic);
						Spine.Unity.Editor.SkeletonGraphicUtility.DetectBlendModeMaterials(graphic);
						if (settings.graphicMaterial.Length > 0) {
							Material named = AssetDatabase.FindAssets(settings.graphicMaterial + " t:Material").Select(g => AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g))).FirstOrDefault(m => m != null && m.name == settings.graphicMaterial);
							if (named == null) errors.Add("material not found: " + settings.graphicMaterial);
							else graphic.material = named;
						}
						// One CanvasRenderer draws one texture with one material: several atlas pages or blend modes need several.
						bool blends = data.Slots.Any(x => x.BlendMode != BlendMode.Normal);
						int pages = asset.atlasAssets.Where(x => x != null).Sum(x => x.MaterialCount);
						if (blends || pages > 1) graphic.allowMultipleCanvasRenderers = true;
						if (settings.skin.Length > 0) graphic.initialSkinName = settings.skin;
						go = graphic.gameObject;
						sa0 = go.GetComponent<SkeletonAnimation>();
					} else if (settings.component == "mecanim") {
						// What the inspector's "Generate Mecanim Controller" and GameObject > Spine > SkeletonMecanim do: a controller
						// with one clip per animation, then a SkeletonMecanim using it.
						Spine.Unity.Editor.SkeletonBaker.GenerateMecanimAnimationClips(asset);
						var mecanim = Spine.Unity.Editor.EditorInstantiation.InstantiateSkeletonMecanim(asset, settings.skin.Length > 0 ? data.FindSkin(settings.skin) : null);
						if (mecanim == null) throw new Exception("SkeletonMecanim could not be created from " + path);
						go = mecanim.gameObject;
						go.GetComponent<Animator>().runtimeAnimatorController = asset.controller;
						sa0 = null;
					} else {
						var components = SpineMcpCheck.NewSkeletonAnimation(asset);
						go = components.skeletonAnimation.gameObject;
						sa0 = components.skeletonAnimation;
						if (settings.skin.Length > 0) components.skeletonRenderer.initialSkinName = settings.skin;
					}
					go.name = Path.GetFileNameWithoutExtension(prefabPath);
					// Followers: a child per bone that tracks it (attach a weapon, an effect, a UI badge).
					addingFollowers = true;
					foreach (string b in settings.followers) {
						var child = settings.component == "graphic" ? new GameObject(b, typeof(RectTransform)) : new GameObject(b);
						child.transform.SetParent(go.transform, false);
						if (settings.component == "graphic") {
							var f = child.AddComponent<BoneFollowerGraphic>();
							f.skeletonGraphic = go.GetComponent<SkeletonGraphic>();
							f.boneName = b;
						} else {
							var f = child.AddComponent<BoneFollower>();
							f.skeletonRenderer = go.GetComponent<SkeletonRenderer>();
							f.boneName = b;
							// Mark it as already on 4.3 so the upgrade check does not run again on load.
							var so = new SerializedObject(f);
							var up = so.FindProperty("wasUpgradedTo43");
							if (up != null) { up.boolValue = true; so.ApplyModifiedPropertiesWithoutUndo(); }
						}
					}
					addingFollowers = false;
					if (sa0 != null) {
						var anim = new SerializedObject(sa0);
						anim.FindProperty("animationName").stringValue = settings.startingAnimation;
						anim.FindProperty("loop").boolValue = settings.loop;
						anim.ApplyModifiedPropertiesWithoutUndo();
					}
					PrefabUtility.SaveAsPrefabAsset(go, prefabPath);
					UnityEngine.Object.DestroyImmediate(go);
				}
			}

			// Read everything back from disk.
			AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
			asset = AssetDatabase.LoadAssetAtPath<SkeletonDataAsset>(path);
			applied = "{\"defaultMix\":" + SpineMcpCheck.F(asset.defaultMix) + ",\"mixes\":[" + string.Join(",", Enumerable.Range(0, asset.fromAnimation.Length)
				.Select(i => "[" + SpineMcpCheck.Q(asset.fromAnimation[i]) + "," + SpineMcpCheck.Q(asset.toAnimation[i]) + "," + SpineMcpCheck.F(asset.duration[i]) + "]")) + "]}";
			if (!string.IsNullOrEmpty(prefabPath) && File.Exists(prefabPath)) {
				var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
				var sa = prefab != null ? prefab.GetComponent<SkeletonAnimation>() : null;
				var sr = prefab != null ? prefab.GetComponent<SkeletonRenderer>() : null;
				var sg = prefab != null ? prefab.GetComponent<SkeletonGraphic>() : null;
				string animName = sa != null ? new SerializedObject(sa).FindProperty("animationName").stringValue : "";
				SkeletonDataAsset linked = sr != null ? sr.skeletonDataAsset : sg != null ? sg.skeletonDataAsset : null;
				prefabReport = "{\"path\":" + SpineMcpCheck.Q(prefabPath) + ",\"skeletonAnimation\":" + (sa != null ? "true" : "false")
					+ ",\"component\":" + SpineMcpCheck.Q(sg != null ? "graphic" : prefab.GetComponent<SkeletonMecanim>() != null ? "mecanim" : sr != null ? "animation" : "none")
					+ ",\"dataAsset\":" + SpineMcpCheck.Q(linked != null ? AssetDatabase.GetAssetPath(linked) : "")
					+ ",\"animation\":" + SpineMcpCheck.Q(animName) + ",\"loop\":" + (sa != null && sa.loop ? "true" : "false")
					+ ",\"skin\":" + SpineMcpCheck.Q(sr != null ? sr.initialSkinName ?? "" : sg != null ? sg.initialSkinName ?? "" : "")
					+ (sg != null ? ",\"material\":" + SpineMcpCheck.Q(sg.material != null ? sg.material.name : "") + ",\"rectTransform\":" + (prefab.GetComponent<RectTransform>() != null ? "true" : "false")
						+ ",\"multipleCanvasRenderers\":" + (sg.allowMultipleCanvasRenderers ? "true" : "false") : "")
					+ ",\"followers\":[" + string.Join(",", prefab.GetComponentsInChildren<BoneFollower>(true).Where(f => f.skeletonRenderer != null).Select(f => SpineMcpCheck.Q(f.boneName))
						.Concat(prefab.GetComponentsInChildren<BoneFollowerGraphic>(true).Where(f => f.skeletonGraphic != null).Select(f => SpineMcpCheck.Q(f.boneName)))) + "]"
					+ MecanimReport(prefab) + "}";
			}
			SpineMcpCheck.AppendSkeleton(json, path, asset, settings.samples, 1f / asset.scale, errors);
		} catch (Exception e) {
			errors.Add(e.Message);
		}
		Application.logMessageReceived -= log;
		json.Append("],\"applied\":").Append(applied).Append(",\"prefab\":").Append(prefabReport).Append(",\"team\":").Append(team);
		json.Append(",\"textures\":[").Append(string.Join(",", SpineMcpCheck.TextureReport(dir, warnings))).Append(']');
		json.Append(",\"referenceAssets\":[").Append(string.Join(",", references.Select(SpineMcpCheck.Q))).Append(']');
		json.Append(",\"errors\":[").Append(string.Join(",", errors.Select(SpineMcpCheck.Q))).Append(']');
		json.Append(",\"warnings\":[").Append(string.Join(",", warnings.Distinct().Select(SpineMcpCheck.Q))).Append("]}");
		File.WriteAllText(output, json.ToString());
		EditorApplication.Exit(errors.Count == 0 ? 0 : 1);
	}

	static string ApplyTexture (SkeletonDataAsset asset, Settings settings, List<string> errors) {
		bool any = settings.textureType.Length > 0 || settings.spriteMode.Length > 0 || settings.sRGB >= 0 || settings.alphaIsTransparency >= 0
			|| settings.mipmaps >= 0 || settings.maxSize > 0 || settings.platformTargets.Length > 0 || settings.spriteSlices;
		if (!any) return "null";
		var pages = new List<string>();
		foreach (var atlasAsset in asset.atlasAssets.OfType<SpineAtlasAsset>()) {
			Atlas atlas = atlasAsset.GetAtlas();
			foreach (var material in atlasAsset.materials.Where(m => m != null && m.mainTexture != null)) {
				Texture texture = material.mainTexture;
				string texturePath = AssetDatabase.GetAssetPath(texture);
				var ti = AssetImporter.GetAtPath(texturePath) as TextureImporter;
				if (ti == null) { errors.Add("no TextureImporter for " + texturePath); continue; }
				if (settings.textureType == "sprite") ti.textureType = TextureImporterType.Sprite;
				else if (settings.textureType == "default") ti.textureType = TextureImporterType.Default;
				if (settings.spriteMode == "multiple") ti.spriteImportMode = SpriteImportMode.Multiple;
				else if (settings.spriteMode == "single") ti.spriteImportMode = SpriteImportMode.Single;
				if (settings.sRGB >= 0) ti.sRGBTexture = settings.sRGB == 1;
				if (settings.alphaIsTransparency >= 0) ti.alphaIsTransparency = settings.alphaIsTransparency == 1;
				if (settings.mipmaps >= 0) ti.mipmapEnabled = settings.mipmaps == 1;
				if (settings.maxSize > 0) ti.maxTextureSize = settings.maxSize;
				for (int i = 0; i < settings.platformTargets.Length; i++) {
					string target = settings.platformTargets[i].ToLowerInvariant() == "ios" ? "iPhone" : settings.platformTargets[i];
					TextureImporterFormat format;
					if (!Enum.TryParse(settings.platformFormats[i], out format)) { errors.Add("unknown texture format: " + settings.platformFormats[i]); continue; }
					var ps = ti.GetPlatformTextureSettings(target);
					ps.overridden = true;
					ps.format = format;
					if (i < settings.platformMaxSizes.Length && settings.platformMaxSizes[i] > 0) ps.maxTextureSize = settings.platformMaxSizes[i];
					ti.SetPlatformTextureSettings(ps);
				}
				int removed = 0, slices = 0;
				bool slicing = settings.spriteSlices && ti.textureType == TextureImporterType.Sprite;
				if (slicing) Slice(ti, texture, atlas, out removed);
				ti.SaveAndReimport();
				if (slicing) slices = AssetDatabase.LoadAllAssetRepresentationsAtPath(texturePath).OfType<Sprite>().Count();
				pages.Add("{\"texture\":" + SpineMcpCheck.Q(texturePath) + ",\"slices\":" + slices + ",\"removedSlices\":" + removed + "}");
			}
		}
		return "{\"pages\":[" + string.Join(",", pages) + "]}";
	}

	static void StraightMaterials (SkeletonDataAsset asset) {
		foreach (var atlasAsset in asset.atlasAssets.OfType<SpineAtlasAsset>())
			foreach (var m in atlasAsset.materials.Where(x => x != null && x.HasProperty("_StraightAlphaInput"))) {
				m.SetFloat("_StraightAlphaInput", 1f);
				m.EnableKeyword("_STRAIGHT_ALPHA_INPUT");
				EditorUtility.SetDirty(m);
			}
		AssetDatabase.SaveAssets();
	}

	static int Slice (TextureImporter ti, Texture texture, Atlas atlas, out int removed) {
		ti.spriteImportMode = SpriteImportMode.Multiple;
		Type factoryType = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("UnityEditor.U2D.Sprites.SpriteDataProviderFactories")).FirstOrDefault(x => x != null);
		if (factoryType == null) throw new Exception("SpriteDataProviderFactories not found (com.unity.2d.sprite)");
		object factory = Activator.CreateInstance(factoryType);
		factoryType.GetMethod("Init").Invoke(factory, null);
		object provider = factoryType.GetMethod("GetSpriteEditorDataProviderFromObject").Invoke(factory, new object[] { ti });
		Type api = provider.GetType().GetInterface("ISpriteEditorDataProvider");
		api.GetMethod("InitSpriteEditorDataProvider").Invoke(provider, null);
		Array rects = (Array)api.GetMethod("GetSpriteRects").Invoke(provider, null);
		Type rectType = rects.GetType().GetElementType();
		while (rectType.GetConstructor(Type.EmptyTypes) == null && rectType.BaseType != null) rectType = rectType.BaseType;
		PropertyInfo name = rectType.GetProperty("name"), area = rectType.GetProperty("rect"), pivot = rectType.GetProperty("pivot");
		var byName = new Dictionary<string, object>();
		foreach (object s in rects) if (!byName.ContainsKey((string)name.GetValue(s))) byName[(string)name.GetValue(s)] = s;
		var slices = new List<object>();
		foreach (AtlasRegion r in atlas.Regions) {
			if (Path.GetFileNameWithoutExtension(r.page.name) != texture.name) continue;
			bool quarter = r.degrees == 270;
			float w = quarter ? r.height : r.width, h = quarter ? r.width : r.height;
			object s;
			if (!byName.TryGetValue(r.name, out s)) {
				s = Activator.CreateInstance(rectType);
				name.SetValue(s, r.name);
				pivot.SetValue(s, new Vector2(0.5f, 0.5f));
			}
			area.SetValue(s, new Rect(r.x, r.page.height - h - r.y, w, h));
			slices.Add(s);
		}
		removed = byName.Count - byName.Values.Count(slices.Contains);
		Array result = Array.CreateInstance(rectType, slices.Count);
		for (int i = 0; i < slices.Count; i++) result.SetValue(slices[i], i);
		api.GetMethod("SetSpriteRects").Invoke(provider, new object[] { result });
		api.GetMethod("Apply").Invoke(provider, null);
		return slices.Count;
	}

	/// <summary>For a SkeletonMecanim prefab: its controller and how many clips it holds.</summary>
	static string MecanimReport (GameObject prefab) {
		var m = prefab.GetComponent<SkeletonMecanim>();
		if (m == null) return "";
		var animator = prefab.GetComponent<Animator>();
		var ctrl = animator != null ? animator.runtimeAnimatorController : null;
		return ",\"mecanim\":true,\"controller\":" + SpineMcpCheck.Q(ctrl != null ? AssetDatabase.GetAssetPath(ctrl) : "") + ",\"clips\":" + (ctrl != null ? AssetDatabase.LoadAllAssetsAtPath(AssetDatabase.GetAssetPath(ctrl)).OfType<AnimationClip>().Count() : 0); // spine-unity stores them as sub-assets of the controller
	}
}
