import { writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const fixtureUrl = requireLoopbackUrl(process.env.PLAN06_GITHUB_FIXTURE_URL);
const acceptanceRoot = requireAbsolutePath(process.env.PLAN06_GITHUB_ACCEPTANCE_ROOT, "acceptance root");
const statusPath = requireAbsolutePath(process.env.PLAN06_GITHUB_KEYRING_STATUS, "keyring status path");
const systemTemp = resolve(tmpdir());
const relativeFromTemp = relative(systemTemp, acceptanceRoot);
if (relativeFromTemp === "" || relativeFromTemp === ".." || relativeFromTemp.startsWith(`..${sep}`) || isAbsolute(relativeFromTemp)) {
  throw new Error("plan06 test transport requires a private acceptance root below the system temp directory");
}
const relativeStatus = relative(acceptanceRoot, statusPath);
if (relativeStatus === "" || relativeStatus === ".." || relativeStatus.startsWith(`..${sep}`) || isAbsolute(relativeStatus)) {
  throw new Error("plan06 keyring status must stay inside the private acceptance root");
}

const allowedKeyringAccounts = new Set([
  "github\0github/app-id",
  "github\0github/private-key",
  "github\0github/installation-id",
]);
const memoryKeyring = new Map();
const keyringStatus = {
  version: 1,
  moduleIntercepted: false,
  entryConstructions: 0,
  setCount: 0,
  getCount: 0,
  deleteCount: 0,
  entries: 0,
  closed: false,
};

function writeStatus() {
  writeFileSync(statusPath, JSON.stringify(keyringStatus), { encoding: "utf8", mode: 0o600 });
}

function clearMemoryKeyring() {
  for (const value of memoryKeyring.values()) value.fill(0);
  memoryKeyring.clear();
  keyringStatus.entries = 0;
}

class IsolatedMemoryKeyringEntry {
  constructor(service, account) {
    this.key = `${service}\0${account}`;
    if (!allowedKeyringAccounts.has(this.key)) {
      throw new Error("plan06 isolated keyring rejected an unapproved account");
    }
    keyringStatus.entryConstructions += 1;
    writeStatus();
  }

  setPassword(value) {
    if (typeof value !== "string") throw new Error("plan06 isolated keyring accepts only strings");
    const prior = memoryKeyring.get(this.key);
    prior?.fill(0);
    memoryKeyring.set(this.key, Buffer.from(value, "utf8"));
    keyringStatus.setCount += 1;
    keyringStatus.entries = memoryKeyring.size;
    writeStatus();
  }

  getPassword() {
    const value = memoryKeyring.get(this.key);
    keyringStatus.getCount += 1;
    writeStatus();
    return value ? Buffer.from(value).toString("utf8") : null;
  }

  deletePassword() {
    const value = memoryKeyring.get(this.key);
    value?.fill(0);
    const existed = memoryKeyring.delete(this.key);
    keyringStatus.deleteCount += 1;
    keyringStatus.entries = memoryKeyring.size;
    writeStatus();
    return existed;
  }
}

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
function isolatedLoad(request, parent, isMain) {
  if (request === "@napi-rs/keyring") {
    keyringStatus.moduleIntercepted = true;
    writeStatus();
    return { Entry: IsolatedMemoryKeyringEntry };
  }
  return originalLoad.call(this, request, parent, isMain);
}
Module._load = isolatedLoad;
if (Module._load !== isolatedLoad) throw new Error("plan06 isolated keyring interception could not be installed");

const originalFetch = globalThis.fetch;
globalThis.fetch = async function plan06LocalGithubTransport(input, init) {
  const rawUrl = typeof input === "string" || input instanceof URL ? input : input.url;
  const sourceUrl = new URL(rawUrl);
  if (sourceUrl.origin !== "https://api.github.com") {
    throw new Error("plan06 test transport blocked external fetch");
  }
  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, fixtureUrl);
  const forwardedInput = input instanceof globalThis.Request ? new globalThis.Request(targetUrl, input) : targetUrl;
  return originalFetch(forwardedInput, init);
};

function requireLoopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("plan06 test transport requires its local fixture URL"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) {
    throw new Error("plan06 test transport fixture must use a plain loopback HTTP origin");
  }
  return url;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`plan06 ${label} must be absolute`);
  return resolve(value);
}

writeStatus();
process.on("SIGINT", clearMemoryKeyring);
process.on("SIGTERM", clearMemoryKeyring);
process.on("message", (message) => {
  if (typeof message !== "object" || message === null || message.type !== "plan06-graceful-shutdown") return;
  if (Object.keys(message).length !== 1 || !process.emit("SIGINT")) {
    throw new Error("plan06 test transport could not invoke the production graceful-shutdown handler");
  }
});
process.once("exit", () => {
  clearMemoryKeyring();
  keyringStatus.closed = true;
  writeStatus();
});
