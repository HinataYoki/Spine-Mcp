import { createRequire } from "node:module";
import type { Browser } from "playwright-core";
import { UserError } from "./project.js";

const require = createRequire(import.meta.url);

/** spine-webgl's browser bundle, added to pages by path (a Windows path works as it is). */
export const SPINE_WEBGL = require.resolve("@esotericsoftware/spine-webgl/dist/iife/spine-webgl.js");

/**
 * Headless Chrome through Playwright: CHROME_BIN, or the installed Google Chrome (channel "chrome" finds it on macOS,
 * Windows and Linux). `what` names the tool in the error.
 */
export async function launchChrome(what: string): Promise<Browser> {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new UserError(`${what} needs playwright-core (npm install) and Google Chrome`);
  }
  return chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: "chrome" }).catch((e: Error) => {
    throw new UserError(`Could not start Chrome for ${what} (${e.message.split("\n")[0]}). Install Google Chrome or set CHROME_BIN.`);
  });
}
