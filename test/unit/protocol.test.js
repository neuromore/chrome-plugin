import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDom, feedbackFrame, readExtensionFile } from "./helpers.js";

const { window } = createDom("");
window.eval(readExtensionFile("src/js/protocol.js"));
const protocol = window.neuromoreProtocol;

/** Compares values from the jsdom realm, whose prototypes differ from Node's. */
const plain = (value) => JSON.parse(JSON.stringify(value));

describe("parseFeedbackFrame", () => {
  it("decodes the byte layout documented by Studio", () => {
    const bytes = Uint8Array.from([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0xd0, 0x3f]);
    assert.deepEqual(plain(protocol.parseFeedbackFrame(bytes.buffer)), {
      index: 1,
      values: [0.25],
    });
  });

  it("reads every channel value", () => {
    const frame = protocol.parseFeedbackFrame(feedbackFrame(7, 0.5, 0.75));
    assert.equal(frame.index, 7);
    assert.deepEqual(plain(frame.values), [0.5, 0.75]);
  });

  it("accepts a frame with no values", () => {
    assert.equal(protocol.parseFeedbackFrame(feedbackFrame(3)).values.length, 0);
  });

  it("rejects frames of another type, too short, or with a partial value", () => {
    const otherType = new Uint8Array(feedbackFrame(0, 0.5));
    otherType[0] = 2;
    assert.equal(protocol.parseFeedbackFrame(otherType.buffer), null);
    assert.equal(protocol.parseFeedbackFrame(new ArrayBuffer(0)), null);
    assert.equal(protocol.parseFeedbackFrame(new ArrayBuffer(3)), null);
    assert.equal(protocol.parseFeedbackFrame(new ArrayBuffer(11)), null);
  });
});

describe("parseFeedbackFrame with something other than a buffer", () => {
  for (const value of [undefined, null, 3, "text", {}, { byteLength: 12 }]) {
    it(`returns null for ${JSON.stringify(value) ?? "undefined"}`, () => {
      assert.equal(protocol.parseFeedbackFrame(value), null);
    });
  }
});

describe("parseJsonMessage", () => {
  it("returns the type and data", () => {
    const parsed = protocol.parseJsonMessage('{"header":{"type":"X"},"data":{"a":1}}');
    assert.equal(parsed.type, "X");
    assert.equal(parsed.data.a, 1);
  });

  it("defaults missing or non-object data to an empty object", () => {
    assert.deepEqual(plain(protocol.parseJsonMessage('{"header":{"type":"X"}}').data), {});
    assert.deepEqual(plain(protocol.parseJsonMessage('{"header":{"type":"X"},"data":3}').data), {});
    assert.deepEqual(
      plain(protocol.parseJsonMessage('{"header":{"type":"X"},"data":null}').data),
      {},
    );
  });

  for (const text of [
    "",
    "not json",
    "null",
    "[]",
    "3",
    '{"header":null}',
    '{"header":{"type":1}}',
  ]) {
    it(`returns null for ${JSON.stringify(text)}`, () => {
      assert.equal(protocol.parseJsonMessage(text), null);
    });
  }
});

describe("clampUnit", () => {
  const cases = [
    [0.5, 0.5],
    [0, 0],
    [1, 1],
    [-0.5, 0],
    [1.5, 1],
    [NaN, null],
    [Infinity, null],
    [-Infinity, null],
    [undefined, null],
    ["0.5", null],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${String(input)} to ${expected}`, () => {
      assert.equal(protocol.clampUnit(input), expected);
    });
  }
});

describe("seekSeconds", () => {
  it("treats progress as a fraction of the duration", () => {
    assert.equal(protocol.seekSeconds(0.5, 200), 100);
  });

  it("clamps progress", () => {
    assert.equal(protocol.seekSeconds(2, 200), 200);
    assert.equal(protocol.seekSeconds(-1, 200), 0);
  });

  it("returns null when the duration or progress is unusable", () => {
    assert.equal(protocol.seekSeconds(0.5, NaN), null);
    assert.equal(protocol.seekSeconds(0.5, Infinity), null);
    assert.equal(protocol.seekSeconds(undefined, 200), null);
  });
});

describe("playbackProgress", () => {
  it("is the played fraction", () => {
    assert.equal(protocol.playbackProgress(50, 200), 0.25);
  });

  it("is always a finite number, so it survives JSON", () => {
    assert.equal(protocol.playbackProgress(5, NaN), 0);
    assert.equal(protocol.playbackProgress(5, Infinity), 0);
    assert.equal(protocol.playbackProgress(0, 0), 0);
  });
});

describe("httpUrlOrNull", () => {
  for (const url of ["https://example.com/a?b=1", "http://example.com/"]) {
    it(`allows ${url}`, () => {
      assert.equal(protocol.httpUrlOrNull(url), url);
    });
  }

  const blocked = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "chrome://settings",
    "vbscript:x",
    "/relative",
    "",
    null,
    undefined,
    42,
    { toString: () => "https://example.com/" },
  ];
  for (const url of blocked) {
    it(`blocks ${JSON.stringify(url) ?? String(url)}`, () => {
      assert.equal(protocol.httpUrlOrNull(url), null);
    });
  }
});

describe("isYouTubeHost", () => {
  it("matches youtube.com and its subdomains", () => {
    assert.equal(protocol.isYouTubeHost("youtube.com"), true);
    assert.equal(protocol.isYouTubeHost("www.youtube.com"), true);
    assert.equal(protocol.isYouTubeHost("music.youtube.com"), true);
  });

  it("does not match lookalikes", () => {
    assert.equal(protocol.isYouTubeHost("notyoutube.com"), false);
    assert.equal(protocol.isYouTubeHost("youtube.com.example.org"), false);
    assert.equal(protocol.isYouTubeHost("example.com"), false);
  });
});
