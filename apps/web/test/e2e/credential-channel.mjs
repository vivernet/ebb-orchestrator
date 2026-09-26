import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { createServer, connect } from "node:net";

const RESPONSE_TIMEOUT_MS = 2_000;

function channelError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function frame(status, payload) {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(status, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Создаёт отдельный loopback-канал для передачи пароля только в виде временных байтов. */
export async function createE2EPasswordChannel(password) {
  if (!Buffer.isBuffer(password)) throw new TypeError("password must be a Buffer");
  const channelId = randomBytes(16).toString("hex");
  const ownedPassword = Buffer.from(password);
  const sockets = new Set();
  let closed = false;
  let closePromise;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let request = Buffer.alloc(0);
    let responded = false;
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (request.length > 256) {
        responded = true;
        request.fill(0);
        socket.end(frame(1, Buffer.from("MALFORMED_REQUEST", "ascii")));
      }
    });
    socket.once("end", () => {
      if (responded) return;
      responded = true;
      const newline = request.indexOf(0x0a);
      const duplicate = newline >= 0 && (request.indexOf(0x0a, newline + 1) >= 0 || newline + 1 < request.length);
      const valid = newline === request.length - 1 && request.subarray(0, newline).toString("ascii") === channelId;
      request.fill(0);
      request = Buffer.alloc(0);
      if (duplicate) socket.end(frame(1, Buffer.from("DUPLICATE_REQUEST", "ascii")));
      else if (closed) socket.end(frame(1, Buffer.from("CHANNEL_UNAVAILABLE", "ascii")));
      else if (!valid) socket.end(frame(1, Buffer.from("MALFORMED_REQUEST", "ascii")));
      else socket.end(frame(0, ownedPassword));
    });
    socket.on("error", () => {});
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback listener did not return a TCP address");
  return {
    endpoint: `127.0.0.1:${address.port}/${channelId}`,
    host: "127.0.0.1",
    port: address.port,
    channelId,
    async dispose() {
      if (closePromise) return closePromise;
      closed = true;
      ownedPassword.fill(0);
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
      return closePromise;
    },
  };
}

/** Читает полный password frame с однократным loopback-соединением и ограниченным сроком ожидания. */
export async function readE2EPasswordFromChannel(endpoint) {
  if (endpoint === undefined || endpoint === "") throw channelError("MISSING_ENDPOINT");
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})\/([0-9a-f]{32})$/.exec(endpoint);
  if (!match) throw channelError("MALFORMED_ENDPOINT");
  const port = Number(match[1]);
  if (port > 65535) throw channelError("MALFORMED_ENDPOINT");
  const channelId = match[2];

  return new Promise((resolvePromise, reject) => {
    let data = Buffer.alloc(0);
    let settled = false;
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => fail(channelError("TIMEOUT")), RESPONSE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      data.fill(0);
      socket.removeAllListeners();
      socket.destroy();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    socket.once("connect", () => socket.end(`${channelId}\n`, "ascii"));
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 5) return;
      const status = data.readUInt8(0);
      const length = data.readUInt32BE(1);
      if (length > 1024 * 1024) return fail(channelError("INVALID_RESPONSE"));
      if (data.length < 5 + length) return;
      if (data.length !== 5 + length) return fail(channelError("INVALID_RESPONSE"));
      const payload = Buffer.from(data.subarray(5));
      data.fill(0);
      if (status === 0) {
        settled = true;
        cleanup();
        resolvePromise(payload);
      } else if (status === 1 && payload.length > 0 && /^[\x20-\x7e]+$/.test(payload.toString("ascii"))) {
        const error = channelError("SERVER_ERROR");
        error.remoteCode = payload.toString("ascii");
        payload.fill(0);
        settled = true;
        cleanup();
        reject(error);
      } else {
        payload.fill(0);
        fail(channelError("INVALID_RESPONSE"));
      }
    });
    socket.once("end", () => {
      if (!settled) fail(channelError("EOF"));
    });
    socket.once("error", (error) => {
      if (!settled) fail(error.code === "ECONNREFUSED" || error.code === "ECONNRESET" ? channelError("CHANNEL_UNAVAILABLE", error) : channelError("EOF", error));
    });
  });
}
