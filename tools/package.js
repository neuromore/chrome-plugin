#!/usr/bin/env node
/**
 * Zips extension/ into dist/neuromore-extension-<version>.zip, with manifest.json
 * at the zip root and the version taken from extension/manifest.json.
 *
 *   npm run package
 *   npm run package -- --check-tag v1.0   also fail unless the tag is v<manifest version>
 *
 * Needs the system `zip` and `unzip` commands and no npm dependencies, so the
 * release workflow can run it without installing anything.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTENSION_DIR = join(ROOT, "extension");
const DIST_DIR = join(ROOT, "dist");

/** Returns the version in extension/manifest.json. */
export function manifestVersion() {
  const { version } = JSON.parse(readFileSync(join(EXTENSION_DIR, "manifest.json"), "utf8"));
  // Chrome's rule: one to four dot-separated integers.
  if (!/^\d+(\.\d+){0,3}$/.test(version ?? "")) {
    throw new Error(`extension/manifest.json has an invalid version: "${version}"`);
  }
  return version;
}

/** Builds the zip and returns its path. */
export function packageExtension() {
  const output = join(DIST_DIR, `neuromore-extension-${manifestVersion()}.zip`);
  mkdirSync(DIST_DIR, { recursive: true });
  // zip adds to an existing archive, which would keep files deleted since.
  rmSync(output, { force: true });
  execFileSync("zip", ["-q", "-r", "-X", output, ".", "-x", "*.DS_Store"], { cwd: EXTENSION_DIR });
  // Apache-2.0 section 4 requires giving recipients a copy of the license.
  execFileSync("zip", ["-q", "-j", "-X", output, join(ROOT, "LICENSE"), join(ROOT, "NOTICE")]);

  const entries = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" }).split("\n");
  for (const required of ["manifest.json", "LICENSE", "NOTICE"]) {
    if (!entries.includes(required)) throw new Error(`${output} has no ${required} at its root`);
  }
  return output;
}

function main() {
  const { values } = parseArgs({ options: { "check-tag": { type: "string" } } });
  const tag = values["check-tag"];
  if (tag !== undefined && tag !== `v${manifestVersion()}`) {
    throw new Error(
      `Tag "${tag}" does not match the manifest version: expected "v${manifestVersion()}"`,
    );
  }
  console.log(packageExtension());
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
