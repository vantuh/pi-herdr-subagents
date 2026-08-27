#!/usr/bin/env node
// Fake `herdr` binary for integration tests.
//
// The extension shells out through HERDR_BIN_PATH, so the only way to fake
// Herdr without a real server is a real executable. This one holds no logic:
// it forwards argv to the FakeHerdr server running inside the test process
// (see fake-herdr.ts) and replays the response, so all simulated Herdr state
// stays inspectable from the test.
import { createConnection } from "node:net";

const socketPath = process.env.HERDR_FAKE_CLI_SOCKET;
if (!socketPath) {
  process.stderr.write("HERDR_FAKE_CLI_SOCKET is not set\n");
  process.exit(2);
}

const socket = createConnection(socketPath);
let buffer = "";

socket.setEncoding("utf8");
socket.on("connect", () => {
  socket.write(`${JSON.stringify({ argv: process.argv.slice(2) })}\n`);
});
socket.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  const response = JSON.parse(buffer.slice(0, newline));
  socket.end();
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exit(response.code ?? 0);
});
socket.on("error", (error) => {
  process.stderr.write(`fake herdr shim: ${error.message}\n`);
  process.exit(2);
});
