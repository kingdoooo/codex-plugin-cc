import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { makeTempDir } from "./helpers.mjs";

test("sendBrokerShutdown resolves when the broker accepts the socket but never replies", async () => {
  const socketPath = path.join(makeTempDir(), "broker.sock");
  let receivedShutdown = false;

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (String(chunk).includes("broker/shutdown")) {
        receivedShutdown = true;
      }
      // Deliberately keep the socket open without responding.
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const startedAt = Date.now();
    await sendBrokerShutdown(`unix:${socketPath}`, 50);
    assert.equal(receivedShutdown, true);
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  }
});
