import { setEditorProbe } from "../src/spine/editor.js";

// Tests pin the editor state (G104): a Spine editor the developer has open would otherwise send every test write to a
// staging copy. Tests about the editor set their own probe; the real process list is tested in windows.test.ts.
setEditorProbe({ processes: () => [] });
