import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXTENSION_DIR, createDom, readExtensionFile } from "./helpers.js";

const manifest = JSON.parse(readExtensionFile("manifest.json"));
const popup = createDom(readExtensionFile("controlWidget.html")).window.document;

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("manifest", () => {
  it("is a three-part version", () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  });

  it("asks only for the permissions it needs", () => {
    assert.deepEqual(manifest.permissions.toSorted(), ["activeTab", "scripting"]);
    assert.equal(manifest.host_permissions, undefined);
  });

  it("has no background worker, since nothing needs one", () => {
    assert.equal(manifest.background, undefined);
  });

  it("names the project and links to the repository", () => {
    assert.equal(manifest.name, "neuromore");
    assert.equal(manifest.homepage_url, "https://github.com/neuromore/chrome-plugin");
  });

  it("references icons and a popup that exist", () => {
    const files = [
      manifest.action.default_popup,
      ...Object.values(manifest.action.default_icon),
      ...Object.values(manifest.icons),
    ];
    for (const file of files) assert.ok(existsSync(join(EXTENSION_DIR, file)), file);
  });
});

describe("no remote resources", () => {
  it("loads stylesheets, scripts and images from the extension only", () => {
    const sources = [...popup.querySelectorAll("link[href], script[src], img[src]")].map(
      (element) => element.getAttribute("href") ?? element.getAttribute("src"),
    );
    assert.ok(sources.length > 0);
    for (const source of sources) {
      assert.doesNotMatch(source, /^([a-z]+:)?\/\//i);
      assert.ok(existsSync(join(EXTENSION_DIR, source)), source);
    }
  });

  it("imports nothing remote from the stylesheet", () => {
    assert.doesNotMatch(readExtensionFile("src/css/style.css"), /@import|url\(/);
  });
});

describe("popup shortcuts", () => {
  const links = [...popup.querySelectorAll(".site-links a")];

  it("are plain text links to the generic sites", () => {
    assert.deepEqual(
      links.map((link) => new URL(link.href).hostname),
      [
        "www.netflix.com",
        "www.youtube.com",
        "www.primevideo.com",
        "open.spotify.com",
        "music.apple.com",
      ],
    );
    for (const link of links) assert.notEqual(link.textContent.trim(), "");
    assert.equal(popup.querySelectorAll("img").length, 0);
  });

  it("open a new tab without giving it a window handle", () => {
    for (const link of links) {
      assert.equal(link.target, "_blank");
      assert.equal(link.rel, "noopener");
    }
  });

  it("no third-party logo files ship", () => {
    assert.deepEqual(
      listFiles(EXTENSION_DIR).filter((file) =>
        /Logos|Netflix|Spotify|Youtube|prime_video|Apple/.test(file),
      ),
      [],
    );
  });
});
