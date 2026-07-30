import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { BROKER_BUSY_RPC_CODE } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

// These tests drive the real broker over its real socket against a fake upstream
// app-server whose turn/start ACK is withheld until the test releases it. That
// timing — a forwarded turn/start with no ACK yet, plus a turn/interrupt from the
// same client — is what the broker's request-ownership tracking has to get right,
// and it cannot be produced through the companion CLI.

function buildTurn(id, status = "inProgress") {
  return { id, status, items: [], error: null };
}

function fakeAppServerSource(controlDir) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const CONTROL_DIR = ${JSON.stringify(controlDir)};
const REQUESTS = path.join(CONTROL_DIR, "requests.jsonl");
const COMMANDS = path.join(CONTROL_DIR, "commands.jsonl");

let pendingStart = null;
let consumed = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

// The test drives this server by appending commands to a file; polling keeps the
// fake dependency-free and makes emission order match append order.
setInterval(() => {
  let lines;
  try {
    lines = fs.readFileSync(COMMANDS, "utf8").split("\\n").filter((line) => line.trim());
  } catch {
    return;
  }
  while (consumed < lines.length) {
    const command = JSON.parse(lines[consumed]);
    consumed += 1;
    if (command.type === "ackStart") {
      if (!pendingStart) {
        continue;
      }
      const start = pendingStart;
      pendingStart = null;
      const turn = { id: command.turnId, status: "inProgress", items: [], error: null };
      send({ id: start.id, result: { turn: turn } });
      send({ method: "turn/started", params: { threadId: start.params.threadId, turn: turn } });
    } else if (command.type === "notify") {
      send({ method: command.method, params: command.params });
    }
  }
}, 20);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  if (message.id === undefined) {
    return;
  }
  fs.appendFileSync(REQUESTS, JSON.stringify({ method: message.method, params: message.params ?? null }) + "\\n");

  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-app-server" } });
    return;
  }
  if (message.method === "turn/start") {
    // Withhold the ACK: the test releases it with an ackStart command, or never.
    pendingStart = { id: message.id, params: message.params ?? {} };
    return;
  }
  // turn/interrupt included: it answers only for itself and never completes the
  // withheld turn/start, which is exactly the upstream-wedged case under test.
  send({ id: message.id, result: {} });
});
`;
}

// Generous by default because every wait in this file is either a process-spawn
// or a message-propagation wait, never a semantic deadline: the broker spawns the
// fake upstream and completes its handshake before it starts listening, and
// `node --test` runs all test files concurrently, so those spawns can be starved
// for seconds on a loaded machine. A tight budget here fails the test before it
// reaches an assertion, which is noise rather than signal. The behavioral
// assertions themselves do not depend on how long the wait took.
const SPAWN_TOLERANT_TIMEOUT_MS = 30_000;

async function waitFor(predicate, { timeoutMs = SPAWN_TOLERANT_TIMEOUT_MS, intervalMs = 25, message = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

function startBroker(t) {
  const repo = makeTempDir("cxc-own-repo-");
  const binDir = makeTempDir("cxc-own-bin-");
  const controlDir = makeTempDir("cxc-own-control-");
  const sessionDir = makeTempDir("cxc-own-session-");
  const requestsPath = path.join(controlDir, "requests.jsonl");
  const commandsPath = path.join(controlDir, "commands.jsonl");
  fs.writeFileSync(requestsPath, "");
  fs.writeFileSync(commandsPath, "");

  const fakePath = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform === "win32") {
    const script = path.join(binDir, "codex-app-server.js");
    fs.writeFileSync(script, fakeAppServerSource(controlDir), "utf8");
    writeExecutable(fakePath, `@echo off\r\nnode "%~dp0codex-app-server.js" %*\r\n`);
  } else {
    writeExecutable(fakePath, fakeAppServerSource(controlDir));
  }

  const endpoint = createBrokerEndpoint(sessionDir, process.platform);
  const { path: socketPath } = parseBrokerEndpoint(endpoint);
  const child = spawn(
    process.execPath,
    [BROKER, "serve", "--endpoint", endpoint, "--cwd", repo, "--pid-file", path.join(sessionDir, "broker.pid")],
    {
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        // High idle window so any broker exit in these tests can only be the
        // abandonment teardown, never the idle timer.
        CODEX_COMPANION_BROKER_IDLE_MS: "60000"
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const clients = [];
  t.after(() => {
    for (const client of clients) {
      client.socket.destroy();
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });

  return {
    child,
    socketPath,
    get stderr() {
      return stderr;
    },
    command(entry) {
      fs.appendFileSync(commandsPath, `${JSON.stringify(entry)}\n`);
    },
    upstreamRequests() {
      return fs
        .readFileSync(requestsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    },
    async connectClient() {
      const client = await connectClient(socketPath);
      clients.push(client);
      return client;
    }
  };
}

async function connectClient(socketPath) {
  const socket = await waitFor(
    () =>
      new Promise((resolve) => {
        const candidate = net.connect(socketPath);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", () => {
          candidate.destroy();
          resolve(null);
        });
      }),
    { message: "the broker to accept a connection" }
  );

  socket.setEncoding("utf8");
  const pending = new Map();
  const notifications = [];
  let buffer = "";
  let nextId = 1;

  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id === undefined || message.id === null) {
        notifications.push(message);
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) {
        continue;
      }
      pending.delete(message.id);
      if (message.error) {
        entry.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code }));
      } else {
        entry.resolve(message.result);
      }
    }
  });

  const client = {
    socket,
    notifications,
    request(method, params) {
      const id = nextId;
      nextId += 1;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
      return promise;
    },
    notificationsFor(threadId) {
      return notifications.filter((message) => message.params?.threadId === threadId);
    },
    close() {
      socket.end();
    },
    abandon() {
      socket.destroy();
    }
  };

  await client.request("initialize", { clientInfo: { name: "test" }, capabilities: {} });
  return client;
}

// The assertion is that the broker exits at all, not that it exits quickly: with
// a 60s idle window an exit can only be the abandonment teardown, so a long wait
// stays meaningful. The wait itself gates on process teardown (closing the
// upstream app-server, then exiting), so it gets the spawn-tolerant budget.
function waitForBrokerExit(child, { timeoutMs = SPAWN_TOLERANT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("The broker did not tear itself down; it is still running with orphaned upstream work."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForUpstream(broker, method) {
  await waitFor(() => broker.upstreamRequests().some((entry) => entry.method === method), {
    message: `upstream to receive ${method}`
  });
}

test("broker tears down when a client interrupts and abandons a turn/start upstream never ACKed", async (t) => {
  const broker = startBroker(t);
  const client = await broker.connectClient();

  // The start is forwarded upstream and wedges there: no ACK, no error.
  const start = client.request("turn/start", { threadId: "thread-A", input: [] });
  start.catch(() => {});
  await waitForUpstream(broker, "turn/start");

  // The client's own turn watchdog fires and interrupts. Upstream answers the
  // interrupt but never settles the start, so the start is still in flight.
  await client.request("turn/interrupt", { threadId: "thread-A", turnId: "turn-A" });

  client.abandon();

  // The owner of the still-in-flight start is gone, so that turn is orphaned:
  // the broker must close the upstream app-server rather than stay reusable.
  assert.equal(await waitForBrokerExit(broker.child), 0);
});

test("broker does not route an abandoned turn's notifications to an unrelated client", async (t) => {
  const broker = startBroker(t);
  const first = await broker.connectClient();

  const firstStart = first.request("turn/start", { threadId: "thread-A", input: [] });
  await waitForUpstream(broker, "turn/start");
  broker.command({ type: "ackStart", turnId: "turn-A" });
  await firstStart;
  broker.command({
    type: "notify",
    method: "turn/completed",
    params: { threadId: "thread-A", turn: buildTurn("turn-A", "completed") }
  });
  await waitFor(() => first.notifications.some((message) => message.method === "turn/completed"), {
    message: "the first client to see turn/completed"
  });

  // A turn that completed and then closed is normal teardown, not abandonment.
  // A regression here would exit the broker promptly on the close, so a short
  // grace period is enough to catch it; unlike the waits above, a longer one only
  // slows the suite down. The stronger check follows: the next connect and turn
  // only succeed against a broker that is still alive.
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(broker.child.exitCode, null, "a completed turn followed by a clean close must not tear the broker down");

  const second = await broker.connectClient();
  const secondStart = second.request("turn/start", { threadId: "thread-B", input: [] });
  await waitFor(() => broker.upstreamRequests().filter((entry) => entry.method === "turn/start").length === 2, {
    message: "upstream to receive the second turn/start"
  });
  broker.command({ type: "ackStart", turnId: "turn-B" });
  await secondStart;

  // Upstream emits a late notification for the first client's retired thread,
  // followed by one for a freshly spawned subagent thread of the live turn. The
  // second is the barrier: once it lands, the stale one has had its chance.
  broker.command({
    type: "notify",
    method: "turn/started",
    params: { threadId: "thread-A", turn: buildTurn("turn-A-late") }
  });
  broker.command({
    type: "notify",
    method: "item/started",
    params: { threadId: "thread-subagent", item: { id: "item-1", type: "agentMessage" } }
  });

  await waitFor(() => second.notificationsFor("thread-subagent").length > 0, {
    message: "the live client to receive its subagent notification"
  });
  assert.deepEqual(
    second.notificationsFor("thread-A"),
    [],
    "the second client must never receive notifications belonging to the first client's turn"
  );
});

test("broker still tears down when an ACKed turn is interrupted and then abandoned", async (t) => {
  const broker = startBroker(t);
  const client = await broker.connectClient();

  const start = client.request("turn/start", { threadId: "thread-A", input: [] });
  await waitForUpstream(broker, "turn/start");
  broker.command({ type: "ackStart", turnId: "turn-A" });
  await start;

  // Upstream acknowledges the interrupt but never emits turn/completed, so the
  // turn is still live upstream when its client disappears.
  await client.request("turn/interrupt", { threadId: "thread-A", turnId: "turn-A" });
  client.abandon();

  assert.equal(await waitForBrokerExit(broker.child), 0);
});

test("broker keeps serving a cross-socket interrupt while another client owns the stream", async (t) => {
  const broker = startBroker(t);
  const owner = await broker.connectClient();

  const start = owner.request("turn/start", { threadId: "thread-A", input: [] });
  await waitForUpstream(broker, "turn/start");
  broker.command({ type: "ackStart", turnId: "turn-A" });
  await start;

  // A second client interrupts the stream it does not own: this must be
  // forwarded, not rejected as busy.
  const other = await broker.connectClient();
  const result = await other.request("turn/interrupt", { threadId: "thread-A", turnId: "turn-A" }).catch((error) => error);
  assert.notEqual(result?.rpcCode, BROKER_BUSY_RPC_CODE, "a cross-socket interrupt must not be refused as busy");
  assert.deepEqual(result, {});

  // The interrupted turn's completion still belongs to the stream owner.
  broker.command({
    type: "notify",
    method: "turn/completed",
    params: { threadId: "thread-A", turn: buildTurn("turn-A", "interrupted") }
  });
  await waitFor(() => owner.notifications.some((message) => message.method === "turn/completed"), {
    message: "the stream owner to receive turn/completed"
  });
  assert.equal(broker.child.exitCode, null, "the broker must stay reusable after a cross-socket interrupt");
});
