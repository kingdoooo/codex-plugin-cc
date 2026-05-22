import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { runCommand, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint, timeoutMs = 5000) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", finish);
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

// Observed failure: the broker process has crashed but its endpoint socket
// file lingers (unix domain) or listener drops without `waitForBrokerEndpoint`
// noticing in the 150ms probe window. `isBrokerEndpointReady` passes, the
// caller trusts the existing session, and every downstream task disconnects
// mid-turn. Add a PID-alive probe so we catch this class up-front and force
// a fresh broker before trusting the socket.
//
// Age-based rotation was considered to cover slow-degradation (broker alive
// but serving unreliably). Dropped in this revision — rotating a healthy
// broker while it may be mid-turn for a concurrent client can interrupt that
// turn. Proper fix for slow degradation needs a real health probe (e.g.
// lightweight RPC round-trip) or graceful drain, which are out of scope
// for this PR. Left as a follow-up.

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 only checks existence; no actual signal delivered
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSessionStale(session) {
  if (!session) return true;
  // PID check — covers crashed-broker case
  if (session.pid != null && !isPidAlive(session.pid)) return true;
  return false;
}

// Recycled-PID guard used before signaling a stale broker. #262's earlier
// POSIX-only `verifyBrokerPid` was superseded here by #343's
// `isExpectedBrokerProcess`, which adds Windows support and is injectable for
// tests (runCommandImpl/platform). teardownBrokerSession runs this check
// itself before killing, so callers no longer need a separate gate.
function readPidFile(pidFile) {
  if (!pidFile || !fs.existsSync(pidFile)) {
    return null;
  }
  const value = Number(fs.readFileSync(pidFile, "utf8").trim());
  return Number.isFinite(value) ? value : null;
}

function getProcessCommand(pid, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const platform = options.platform ?? process.platform;
  const result =
    platform === "win32"
      ? runCommandImpl(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CommandLine }`
          ],
          {
            cwd: options.cwd,
            env: options.env
          }
        )
      : runCommandImpl("ps", ["-p", String(pid), "-o", "command="], {
          cwd: options.cwd,
          env: options.env
        });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function isExpectedBrokerProcess({ pid, endpoint = null, pidFile = null, platform = process.platform, runCommandImpl = runCommand }) {
  if (!Number.isFinite(pid)) {
    return false;
  }

  const recordedPid = readPidFile(pidFile);
  if (recordedPid !== null && recordedPid !== pid) {
    return false;
  }

  const command = getProcessCommand(pid, { platform, runCommandImpl });
  if (!command) {
    return false;
  }

  return (
    command.includes("app-server-broker.mjs") &&
    command.includes("serve") &&
    (!endpoint || command.includes(endpoint)) &&
    (!pidFile || command.includes(pidFile))
  );
}

export async function ensureBrokerSession(cwd, options = {}) {
  const killProcess = options.killProcess ?? terminateProcessTree;
  const existing = loadBrokerSession(cwd);
  if (existing && !isSessionStale(existing) && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    // teardownBrokerSession runs its own recycled-PID guard
    // (validateProcess → isExpectedBrokerProcess) before signaling, and
    // defaults killProcess to terminateProcessTree so the whole broker +
    // app-server + MCP subtree is reaped, not just the broker PID.
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess,
      validateProcess: options.validateProcess,
      platform: options.platform,
      runCommandImpl: options.runCommandImpl
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess,
      validateProcess: options.validateProcess,
      platform: options.platform,
      runCommandImpl: options.runCommandImpl
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = terminateProcessTree,
  validateProcess = isExpectedBrokerProcess,
  platform = process.platform,
  runCommandImpl = runCommand
}) {
  if (Number.isFinite(pid) && validateProcess({ pid, endpoint, pidFile, platform, runCommandImpl })) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
