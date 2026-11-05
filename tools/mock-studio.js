#!/usr/bin/env node
/**
 * Mock of neuromore Studio's WebSocket server, for testing the extension
 * without Studio or EEG hardware.
 *
 *   npm run mock-studio                 listen on 127.0.0.1:4547
 *   npm run mock-studio -- --port 5000  listen on another port
 *
 * While it runs, type a command and press Enter: start, stop, play [fraction],
 * pause, url <address>, quit.
 *
 * From a test:
 *
 *   import { start } from "../../tools/mock-studio.js";
 *   const studio = await start({ port: 0 });
 *   // studio.port, studio.received, studio.broadcast(...), studio.close()
 *
 * The protocol was read from the source of github.com/neuromore/studio, not
 * captured from a running Studio. WebsocketProtocol.h and WebsocketServer.cpp
 * are identical at tag 1.7.3 and at master 17409bb.
 *
 *   src/Engine/Networking/WebsocketProtocol.h   JSON envelope, messages, binary frame layout
 *   src/QtBase/Networking/WebsocketServer.cpp   connect and session sequences, 100 ms timer
 *   src/Engine/Graph/OutputNode.cpp             feedback values and sample rates
 *   src/Engine/Graph/ScreenBrightnessNode.h     "Brightness Control" node name
 *   src/Engine/Graph/VolumeControlNode.h        "Volume Control" node name
 *   src/Engine/Graph/Actions.cpp                player and URL actions, progress as a 0..1 fraction
 *
 * Deliberate differences from Studio:
 *   - It listens on 127.0.0.1 only. Studio listens on all interfaces.
 *   - It has no state machine, so client messages are logged and have no effect.
 *   - A session is already running at startup, so a client gets frames right away.
 *   - It never sends ON_STATEMACHINE_LOADED or ON_EXPERIENCE_LOADED, which the
 *     extension ignores.
 */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";

export const DEFAULT_PORT = 4547;

// Binary frame layout (WebsocketProtocol.h): uint16 type, uint16 index into
// data.feedbacks, then one float64 per channel, all little-endian on the
// platforms Studio ships for.
const CUSTOM_FEEDBACK = 1;
const FRAME_HEADER_BYTES = 4;
const FRAME_VALUE_BYTES = 8;

// Studio's WebsocketServer timer sends one frame per node at this interval,
// whatever the node's sample rate is.
const FRAME_INTERVAL_MS = 100;

// Slow, out-of-phase waves that stay inside 0.1..0.9 so the page stays visible
// and audible. Real Studio values are unclamped and can start at 0.0; pass your
// own `value` function to start() to reproduce that.
const DEFAULT_FEEDBACKS = [
  { name: "Volume Control", sample_rate: 30.0, channels: ["Sine"], periodSeconds: 20 },
  { name: "Brightness Control", sample_rate: 30.0, channels: ["Sine"], periodSeconds: 32 },
];

const defaultValue = (feedback, seconds) =>
  0.5 + 0.4 * Math.sin((2 * Math.PI * seconds) / feedback.periodSeconds);

/** Builds a JSON message in Studio's envelope. */
export function message(type, data = {}) {
  return JSON.stringify({ header: { type }, data });
}

/**
 * Encodes one custom feedback frame. Studio writes channel 0's current value
 * into every channel slot, so all values in a frame are the same.
 */
export function encodeFrame(index, value, channelCount = 1) {
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + FRAME_VALUE_BYTES * channelCount);
  frame.writeUInt16LE(CUSTOM_FEEDBACK, 0);
  frame.writeUInt16LE(index, 2);
  for (let channel = 0; channel < channelCount; channel++) {
    frame.writeDoubleLE(value, FRAME_HEADER_BYTES + FRAME_VALUE_BYTES * channel);
  }
  return frame;
}

function layoutMessage(feedbacks) {
  return message("ON_FEEDBACK_LAYOUT", {
    feedbacks: feedbacks.map(({ name, sample_rate, channels }) => ({
      name,
      sample_rate,
      channels,
    })),
  });
}

function sessionStartedMessage() {
  // Studio's format has no milliseconds, for example 2015-10-31T09:15:32Z.
  const start = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return message("ON_SESSION_STARTED", { start });
}

/**
 * Starts a mock server.
 *
 * @param {object} [options]
 * @param {number} [options.port=4547] Port to listen on. 0 picks a free port.
 * @param {object[]} [options.feedbacks] Layout entries: { name, sample_rate, channels }.
 *   An entry with no channels stays in the layout and gets no frames, as in Studio.
 * @param {(feedback: object, seconds: number) => number} [options.value] Value to
 *   send for a layout entry, given the seconds since the server started.
 * @param {number} [options.intervalMs=100] Time between rounds of frames.
 * @param {boolean} [options.session=true] Whether a session is running at startup.
 * @param {(line: string) => void} [options.log] Logger. Silent by default.
 * @returns {Promise<{
 *   port: number,
 *   received: object[],
 *   broadcast: (data: string | Buffer) => void,
 *   startSession: () => void,
 *   stopSession: () => void,
 *   close: () => Promise<void>,
 * }>} `received` collects the parsed JSON messages clients have sent.
 */
export async function start({
  port = DEFAULT_PORT,
  feedbacks = DEFAULT_FEEDBACKS,
  value = defaultValue,
  intervalMs = FRAME_INTERVAL_MS,
  session = true,
  log = () => {},
} = {}) {
  const wss = await new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port });
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
  wss.on("error", (error) => log(`server error: ${error.message}`));

  const received = [];
  const startedAt = Date.now();
  let sessionRunning = session;

  const broadcast = (data) => {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  };

  const startSession = () => {
    if (sessionRunning) return;
    sessionRunning = true;
    broadcast(sessionStartedMessage());
    broadcast(layoutMessage(feedbacks));
    log("session started");
  };

  const stopSession = () => {
    if (!sessionRunning) return;
    sessionRunning = false;
    broadcast(message("ON_SESSION_STOPPED"));
    log("session stopped");
  };

  wss.on("connection", (socket) => {
    log(`client connected (${wss.clients.size} total)`);
    socket.send(message("ON_CLASSIFIER_LOADED", { name: "Mock Classifier" }));
    if (sessionRunning) {
      socket.send(sessionStartedMessage());
      socket.send(layoutMessage(feedbacks));
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        log("ignored a binary frame from a client");
        return;
      }
      const text = data.toString();
      try {
        const parsed = JSON.parse(text);
        received.push(parsed);
        log(`received ${text}`);
      } catch {
        log(`ignored invalid JSON from a client: ${text}`);
      }
    });
    socket.on("error", (error) => log(`client error: ${error.message}`));
    socket.on("close", () => log(`client disconnected (${wss.clients.size} left)`));
  });

  const timer = setInterval(() => {
    if (!sessionRunning) return;
    const seconds = (Date.now() - startedAt) / 1000;
    feedbacks.forEach((feedback, index) => {
      const channelCount = feedback.channels.length;
      if (channelCount > 0) broadcast(encodeFrame(index, value(feedback, seconds), channelCount));
    });
  }, intervalMs);

  let closing;
  const close = () => {
    closing ??= new Promise((resolve) => {
      clearInterval(timer);
      stopSession();
      wss.close(() => resolve());
      const clients = [...wss.clients];
      clients.forEach((client) => client.close(1001, "Mock Studio is shutting down"));
      // A client that never answers the close handshake must not keep us alive.
      setTimeout(() => clients.forEach((client) => client.terminate()), 500).unref();
    });
    return closing;
  };

  return {
    port: wss.address().port,
    received,
    broadcast,
    startSession,
    stopSession,
    close,
  };
}

function parseCliOptions() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: String(DEFAULT_PORT) },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: npm run mock-studio -- [--port <port>]");
    process.exit(0);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a number from 0 to 65535, got "${values.port}"`);
  }
  return { port };
}

async function main() {
  const { port } = parseCliOptions();
  const studio = await start({ port, log: console.log });
  console.log(`Mock Studio listening on ws://127.0.0.1:${studio.port}`);
  console.log("Commands: start, stop, play [fraction], pause, url <address>, quit");

  const shutDown = async () => {
    await studio.close();
    process.exit(0);
  };
  process.on("SIGINT", shutDown);
  process.on("SIGTERM", shutDown);

  const commands = {
    start: () => studio.startSession(),
    stop: () => studio.stopSession(),
    play: (progress = "0.5") =>
      studio.broadcast(
        message("BROWSER_START_PLAYER", { progress: Number(progress), fullscreen: false }),
      ),
    pause: () => studio.broadcast(message("BROWSER_PAUSE_PLAYER")),
    url: (url = "https://example.com/") => studio.broadcast(message("OPEN_URL", { url })),
    quit: shutDown,
  };

  // Stdin ending is not a reason to quit: the server may run with no terminal.
  createInterface({ input: process.stdin }).on("line", (line) => {
    const [name, ...args] = line.trim().split(/\s+/);
    if (!name) return;
    if (Object.hasOwn(commands, name)) commands[name](...args);
    else console.log(`Unknown command "${name}"`);
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${error.port} is in use. Is Studio running? Try --port <port>.`
        : error.message,
    );
    process.exit(1);
  });
}
