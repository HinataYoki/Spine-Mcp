// Builds the headless player spine_unity_check perf runs (unity/Perf/SpineMcpPerf.cs): one scene with the measuring
// script, and spine-unity's Spine/Skeleton shader kept in the build through a material in Resources.
// Invoked as: Unity -batchmode -nographics -projectPath P -executeMethod SpineMcpPerfBuild.Build
//   -spineMcpPerfPlayer /abs/out/SpineMcpPerf(.app|.exe) -spineMcpOut /abs/build.json
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class SpineMcpPerfBuild {
	const string Folder = "Assets/SpineMcpPerf", Scene = Folder + "/Perf.unity", MaterialPath = Folder + "/Resources/SpineMcpPerfSkeleton.mat";

	public static void Build () {
		string player = SpineMcpCheck.Arg("-spineMcpPerfPlayer"), output = SpineMcpCheck.Arg("-spineMcpOut");
		string error = null;
		try {
			Directory.CreateDirectory(Folder + "/Resources");
			var shader = Shader.Find("Spine/Skeleton");
			if (shader == null) throw new Exception("Spine/Skeleton shader not found (spine-unity not imported)");
			if (AssetDatabase.LoadAssetAtPath<Material>(MaterialPath) == null) {
				AssetDatabase.CreateAsset(new Material(shader), MaterialPath);
				AssetDatabase.SaveAssets();
			}
			var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
			new GameObject("SpineMcpPerf").AddComponent<SpineMcpPerf>();
			EditorSceneManager.SaveScene(scene, Scene);
			PlayerSettings.runInBackground = true;
			PlayerSettings.SetScriptingBackend(UnityEditor.Build.NamedBuildTarget.Standalone, ScriptingImplementation.Mono2x);
			var target = Application.platform == RuntimePlatform.WindowsEditor ? BuildTarget.StandaloneWindows64 : BuildTarget.StandaloneOSX;
			var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = new[] { Scene }, locationPathName = player, target = target, options = BuildOptions.None });
			if (report.summary.result != BuildResult.Succeeded) error = "build " + report.summary.result + ": " + report.summary.totalErrors + " error(s)";
		} catch (Exception e) {
			error = e.ToString();
		}
		if (output != null) File.WriteAllText(output, "{\"ok\":" + (error == null ? "true" : "false") + ",\"error\":" + (error == null ? "null" : SpineMcpCheck.Q(error)) + "}");
		EditorApplication.Exit(error == null ? 0 : 1);
	}
}
