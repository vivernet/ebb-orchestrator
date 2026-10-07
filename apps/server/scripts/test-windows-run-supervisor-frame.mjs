import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("WINDOWS_FRAME_ACCEPTANCE_REQUIRES_WINDOWS");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(serverDirectory, "..", "..");
const buildScript = join(scriptDirectory, "build-windows-run-supervisor.mjs");
const executable = join(serverDirectory, "dist", "native", "windows-run-supervisor", "ebb-run-supervisor-frame-test.exe");
execFileSync(process.execPath, [buildScript, "--frame-acceptance"], {
  cwd: repositoryDirectory,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});
assert.equal(existsSync(executable), true, "frame acceptance executable must be built");

const nonce = "a".repeat(64);
const runId = "12345678-1234-4234-9234-123456789abc";
const profileHome = `C:\\auth\\profiles\\ebb-orchestrator-run-${runId}`;
const chain = [
  ["0000000000000001", "0".repeat(32)],
  ["0000000000000001", "1".repeat(32)],
  ["0000000000000001", "2".repeat(32)],
  ["0000000000000001", "3".repeat(32)],
];
const environment = [
  ["HERMES_HOME", profileHome],
  ["HOME", `${profileHome}\\home`],
  ["HERMES_CONFIG", `${profileHome}\\config.yaml`],
];

function u32(value) {
  const field = Buffer.alloc(4);
  field.writeUInt32BE(value);
  return field;
}

function string(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function identity(volume, fileId) {
  return Buffer.concat([string(volume), string(fileId)]);
}

function encodeFrame({ wrongTerminalIdentity = false, wrongTargetVolume = false } = {}) {
  const pieces = [
    u32(0x45424233), u32(0), u32(1), u32(environment.length),
    string("C:\\Windows\\System32\\cmd.exe"), string("C:\\Windows\\System32"), string("/c"),
    ...environment.flatMap(([key, value]) => [string(key), string(value)]),
    u32(1),
    string(profileHome), string("C:\\Hermes\\hermes.exe"),
    identity("0000000000000001", "a".repeat(32)),
    identity("0000000000000001", "b".repeat(32)),
    identity("0000000000000001", "3".repeat(32)),
    identity(wrongTargetVolume ? "0000000000000002" : "0000000000000001", "7".repeat(32)),
    identity("0000000000000001", "8".repeat(32)),
    string(runId), u32(1), u32(1), u32(chain.length),
    ...chain.flatMap(([volume, fileId], index) => [
      string(volume), string(wrongTerminalIdentity && index === chain.length - 1 ? "4".repeat(32) : fileId),
    ]),
    string("b".repeat(64)), string("C:\\snapshot\\root"),
    identity("0000000000000001", "5".repeat(32)),
    string("c".repeat(64)), string("C:\\snapshot\\projection.bin"), string("d".repeat(64)), u32(76),
  ];
  const frame = Buffer.concat(pieces);
  frame.writeUInt32BE(frame.length, 4);
  return frame;
}

const ack = Buffer.from(`EBBACK01${nonce}`, "ascii");

function invoke(input) {
  const result = spawnSync(executable, ["validate-frame", nonce], {
    input,
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" },
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "native parser acceptance process should start");
  return result;
}

const validFrame = encodeFrame();
const accepted = invoke(Buffer.concat([validFrame, ack]));
assert.equal(accepted.status, 0, `valid four-entry EBB3 frame should pass: ${accepted.stderr}`);
assert.equal(accepted.stdout, "FRAME_VALID\n");

const truncated = invoke(Buffer.concat([validFrame.subarray(0, validFrame.length - 1), ack]));
assert.notEqual(truncated.status, 0, "truncated EBB3 frame must fail closed");
assert.match(truncated.stdout, /UNKNOWN\tLAUNCH_FRAME_INVALID/u);

const oversizeHeader = Buffer.concat([u32(0x45424233), u32(256 * 1024 + 1)]);
const oversize = invoke(Buffer.concat([oversizeHeader, ack]));
assert.notEqual(oversize.status, 0, "oversized declared EBB3 frame must fail closed");
assert.match(oversize.stdout, /UNKNOWN\tLAUNCH_FRAME_INVALID/u);

const declaredTrailing = Buffer.concat([validFrame, Buffer.from([0]), ack]);
declaredTrailing.writeUInt32BE(declaredTrailing.length - ack.length, 4);
const trailingWithinFrame = invoke(declaredTrailing);
assert.notEqual(trailingWithinFrame.status, 0, "bytes left within the declared frame must not be accepted");
assert.match(trailingWithinFrame.stdout, /UNKNOWN\tLAUNCH_FRAME_INVALID/u);

const wrongIds = invoke(Buffer.concat([encodeFrame({ wrongTerminalIdentity: true }), ack]));
assert.notEqual(wrongIds.status, 0, "terminal chain identity mismatch must fail closed");
assert.match(wrongIds.stdout, /UNKNOWN\tLAUNCH_FRAME_INVALID/u);

const wrongTargetVolume = invoke(Buffer.concat([encodeFrame({ wrongTargetVolume: true }), ack]));
assert.notEqual(wrongTargetVolume.status, 0, "profile target identity on another volume must fail closed");
assert.match(wrongTargetVolume.stdout, /UNKNOWN\tLAUNCH_FRAME_INVALID/u);

const trailingCanary = invoke(Buffer.concat([validFrame, Buffer.from([1])]));
assert.notEqual(trailingCanary.status, 0, "one trailing 0x01 byte must not authorize ResumeThread");
assert.match(trailingCanary.stdout, /UNKNOWN\tLAUNCH_ACK_REJECTED/u);

const misalignedAck = invoke(Buffer.concat([validFrame, Buffer.from([1]), ack]));
assert.notEqual(misalignedAck.status, 0, "a trailing byte before the nonce-bound ACK must not authorize ResumeThread");
assert.match(misalignedAck.stdout, /UNKNOWN\tLAUNCH_ACK_REJECTED/u);

console.log("WINDOWS_RUN_SUPERVISOR_FRAME_ACCEPTANCE_PASS valid=1 truncated=1 oversized=1 trailing=2 wrong_ids=2");
