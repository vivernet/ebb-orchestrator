import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.stdout.write("Hermes file identity helper is only required on Windows.\n");
  process.exit(0);
}
if (process.argv.length !== 2) throw new Error("HERMES_IDENTITY_TEST_UNSUPPORTED_ARGUMENT");
const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = join(serverDirectory, "dist/native/hermes-profile-path/ebb-hermes-profile-path.exe");
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, "ebb-hermes-file-identity-"));

function invoke(args) {
  const result = spawnSync(executable, args, {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 5_000, maxBuffer: 2_048,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function identity(filename) {
  const result = invoke(["verify-host-path", "file", filename]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ["fileId", "kind", "path", "status", "volumeSerial"]);
  assert.equal(value.status, "SAFE_PATH");
  assert.equal(value.kind, "file");
  assert.equal(value.path.startsWith("\\\\?\\"), false);
  assert.equal(
    value.path.toLowerCase(),
    realpathSync(filename).replace(/^\\\\\?\\/u, "").toLowerCase(),
  );
  assert.match(value.volumeSerial, /^[a-f0-9]{16}$/u);
  assert.match(value.fileId, /^[a-f0-9]{32}$/u);
  return { volumeSerial: value.volumeSerial, fileId: value.fileId };
}

try {
  const file = join(fixture, "identity проба.txt");
  writeFileSync(file, "first content");
  const original = identity(file);
  const extendedFilePath = `\\\\?\\${file}`;
  assert.deepEqual(identity(extendedFilePath), original);
  assert.deepEqual(identity(file.toLowerCase()), original);
  assert.deepEqual(identity(file), original);
  writeFileSync(file, "rewritten content");
  assert.deepEqual(identity(file), original);

  const alias = join(fixture, "hard-link.txt");
  linkSync(file, alias);
  assert.deepEqual(identity(alias), original);
  renameSync(file, join(fixture, "previous.txt"));
  writeFileSync(file, "new object");
  assert.notDeepEqual(identity(file), original);

  const target = join(fixture, "target");
  mkdirSync(target);
  writeFileSync(join(target, "nested.txt"), "target content");
  const junction = join(fixture, "junction");
  symlinkSync(target, junction, "junction");
  for (const [args, expectedDiagnostic, expectedStatus] of [
    [["verify-host-path", "file", fixture], "", null],
    [["verify-host-path", "file", join(fixture, "missing.txt")], "", null],
    [["verify-host-path", "file", join(junction, "nested.txt")], "HERMES_PATH_IDENTITY_EXPECTED_PATH_MISMATCH", 36],
    [["verify-host-path", "file", `${fixture}\\target\\..\\identity проба.txt`], "", null],
  ]) {
    const result = invoke(args);
    if (expectedStatus === null) assert.notEqual(result.status, 0);
    else assert.equal(result.status, expectedStatus);
    assert.equal(result.stdout, "");
    if (expectedDiagnostic) {
      assert.match(result.stderr, new RegExp(`^${expectedDiagnostic}\\r?\\n$`, "u"));
      assert.equal(result.stderr.includes(fixture), false);
    } else {
      assert.equal(result.stderr, "");
    }
  }
  for (const args of [
    [], ["verify-host-path", "directory", fixture],
    ["verify-host-path", "file", file, "extra"],
    ["verify-safe-path", "file", file],
    ["create-profile", fixture, "unused"],
    ["source-cache-root-ensure", fixture],
    ["project-selection", fixture, fixture, "unused"],
    ["verify-host-path", "file", "\\\\?\\UNC\\server\\share\\file"],
    ["verify-host-path", "file", "\\\\.\\C:\\fixture\\file"],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
  process.stdout.write("Windows Hermes file identity: stable identity, hard links, replacement, Unicode, invalid commands and reparse refusal passed.\n");
} finally {
  // Удаляется только созданный выше одноразовый fixture в системном temp.
  const cleanupPath = resolve(fixture);
  assert.equal(dirname(cleanupPath), temporaryRoot, "HERMES_IDENTITY_TEST_CLEANUP_UNSAFE");
  assert.ok(basename(cleanupPath).startsWith("ebb-hermes-file-identity-"), "HERMES_IDENTITY_TEST_CLEANUP_UNSAFE");
  rmSync(cleanupPath, { recursive: true, force: true });
}
