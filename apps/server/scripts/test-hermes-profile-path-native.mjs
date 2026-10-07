import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { resolveWindowsMsvcEnvironment } from "./windows-msvc-environment.mjs";

if (process.platform !== "win32" && process.platform !== "linux") {
  throw new Error("HERMES_PROFILE_PATH_NATIVE_TEST_UNSUPPORTED_PLATFORM");
}

const serverDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeSource = readFileSync(join(serverDirectory, "native", "hermes-profile-path", "ebb-hermes-profile-path.cpp"), "utf8");
assert.match(nativeSource, /bool parseSelection\(const std::function<int\(\)>& nextByte, Selection& selection\)/u,
  "selection parsing must consume the opened config stream rather than a materialized config string");
assert.match(nativeSource, /bool readWindowsConfig\(const std::wstring& configHome, Selection& selection\)/u);
assert.match(nativeSource, /bool readPosixConfig\(const std::string& home, Selection& selection\)/u);
assert.match(nativeSource, /int verifySafeWindowsFilePathChain\(const std::wstring& rawPath, const std::wstring& rawStrictRoot\)/u,
  "file identities beneath a managed root must use a held no-follow path chain and an explicit strict boundary");
assert.match(nativeSource, /captureValue = inModel && indent == 2 && \(candidateKey == "provider" \|\| candidateKey == "default"\)/u,
  "only the selected provider and model scalar values may be retained by the YAML scanner");
const executable = join(serverDirectory, "dist", "native", "hermes-profile-path",
  process.platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path");
const tempRoot = realpathSync(tmpdir());
const sandbox = mkdtempSync(join(tempRoot, "ebb-hermes-profile-path-"));
const canonicalSandbox = realpathSync(sandbox);

const childEnvironment = process.platform === "win32"
  ? { ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) }
  : { PATH: "/usr/bin:/bin" };

function makeWindowsFixturePrivate(directory) {
  const powershell = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl = Get-Acl -LiteralPath $path;",
    "$acl.SetAccessRuleProtection($true, $false);",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleAll($entry) };",
    "$acl.SetOwner($identity);",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl;",
    "$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit;",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: directory,
    env: { ...childEnvironment, EBB_HERMES_PROFILE_TEST_ROOT: directory },
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows fixture ACL setup process should start");
  const errorText = String(result.stderr || "").replaceAll(directory, "<test-root>").trim();
  assert.equal(result.status, 0, `Windows fixture root should have a current-user-only ACL: ${errorText}`);
}

async function verifySourceCacheLease(root) {
  const children = [];
  const closeEvents = new Map();
  const trackChild = (child) => {
    children.push(child);
    closeEvents.set(child, new Promise((resolveClose) => child.once("close", resolveClose)));
    return child;
  };
  const start = () => {
    const nonce = randomUUID();
    const child = spawn(executable, ["source-cache-lock", root, String(process.pid), nonce], {
      shell: false, windowsHide: true, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(child);
    let ready = false;
    let stderr = "";
    const acquired = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("native lease READY timeout")), 5000);
      child.once("error", rejectReady);
      child.stdout.on("data", (chunk) => {
        assert.equal(chunk.toString(), process.platform === "win32" ? "SOURCE_CACHE_LOCK_READY\r\n" : "SOURCE_CACHE_LOCK_READY\n", "READY must follow OS lock acquisition");
        ready = true;
        clearTimeout(timer);
        resolveReady();
      });
      child.once("exit", (code) => { clearTimeout(timer); if (!ready) rejectReady(new Error(`native lease exited before READY: ${code}`)); });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); assert.ok(stderr.length <= 1024); });
    const stopped = new Promise((resolveStopped) => child.once("close", (code) => { assert.equal(stderr, ""); resolveStopped(code); }));
    return { child, acquired, stopped, nonce, isReady: () => ready };
  };
  const startReference = (mode) => {
    const nonce = randomUUID();
    const child = spawn(executable, ["source-cache-reference-lock", root, mode, nonce], {
      shell: false, windowsHide: true, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(child);
    let ready = false;
    let stderr = "";
    const acquired = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("native reference lease READY timeout")), 5000);
      child.once("error", rejectReady);
      child.stdout.on("data", (chunk) => {
        assert.equal(chunk.toString(), process.platform === "win32" ? "SOURCE_CACHE_LOCK_READY\r\n" : "SOURCE_CACHE_LOCK_READY\n");
        ready = true;
        clearTimeout(timer);
        resolveReady();
      });
      child.once("exit", (code) => { clearTimeout(timer); if (!ready) rejectReady(new Error(`native reference lease exited before READY: ${code}`)); });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); assert.ok(stderr.length <= 1024); });
    const stopped = new Promise((resolveStopped) => child.once("close", (code) => { assert.equal(stderr, ""); resolveStopped(code); }));
    return { child, acquired, stopped, nonce, isReady: () => ready };
  };
  try {
    const first = start();
    await first.acquired;
    const permanent = join(root, ".source-cache.lock");
    const identity = statSync(permanent, { bigint: true });
    const second = start();
    const third = start();
    const cancelled = start();
    const cancelledReady = cancelled.acquired.catch(() => undefined);
    cancelled.child.stdin.end();
    assert.equal(await cancelled.stopped, 0, "EOF cancels a waiting contender without leaving an orphan");
    await cancelledReady;
    assert.equal(cancelled.isReady(), false, "cancelled waiter must not claim authority");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.equal(second.isReady(), false, "second contender must wait for the first OS owner");
    assert.equal(third.isReady(), false, "third contender must wait for the first OS owner");
    first.child.stdin.end(`RELEASE ${first.nonce}\n`);
    assert.equal(await first.stopped, 0);
    const winner = await Promise.race([second.acquired.then(() => second), third.acquired.then(() => third)]);
    const loser = winner === second ? third : second;
    assert.equal(loser.isReady(), false, "release grants exclusive authority to one contender");
    winner.child.stdin.end(`RELEASE ${winner.nonce}\n`);
    assert.equal(await winner.stopped, 0);
    await loser.acquired;
    loser.child.stdin.end(`RELEASE ${loser.nonce}\n`);
    assert.equal(await loser.stopped, 0);
    const after = statSync(permanent, { bigint: true });
    assert.equal(after.ino, identity.ino, "recovery must retain the permanent lock inode");
    assert.equal(after.dev, identity.dev);
    const ownerCode = `
      const { spawn } = require('node:child_process');
      const { randomUUID } = require('node:crypto');
      const helper = spawn(process.argv[1], ['source-cache-lock', process.argv[2], String(process.pid), randomUUID()], {
        shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: process.env
      });
      helper.stdout.on('data', chunk => process.stdout.write(chunk));
      helper.stderr.on('data', () => process.exitCode = 3);
      helper.on('exit', () => process.stdout.write('HELPER_STOPPED\\n'));
      process.stdin.on('data', () => helper.kill('SIGKILL'));
    `;
    const owner = spawn(process.execPath, ["-e", ownerCode, executable, root], {
      shell: false, windowsHide: true, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(owner);
    let ownerOutput = "";
    owner.stdout.on("data", (chunk) => { ownerOutput += chunk.toString(); });
    const awaitMarker = async (marker) => {
      const deadline = Date.now() + 5000;
      while (!ownerOutput.includes(marker)) {
        if (Date.now() > deadline || owner.exitCode !== null) throw new Error("native publisher fixture marker unavailable");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    };
    await awaitMarker("SOURCE_CACHE_LOCK_READY");
    owner.stdin.write("KILL_HELPER\n");
    await awaitMarker("HELPER_STOPPED");
    const blocked = start();
    const blockedReady = blocked.acquired.catch(() => undefined);
    assert.equal(await blocked.stopped, 10, "live publisher reservation survives helper death and blocks another publisher");
    await blockedReady;
    assert.equal(blocked.isReady(), false);
    process.kill(owner.pid, 0);
    const ownerStopped = new Promise((resolveStopped) => owner.once("close", resolveStopped));
    owner.kill("SIGKILL");
    await ownerStopped;
    const recovered = start();
    await recovered.acquired;
    recovered.child.stdin.end(`RELEASE ${recovered.nonce}\n`);
    assert.equal(await recovered.stopped, 0, "dead publisher permits restart takeover using native creation identity");
    const eof = start();
    await eof.acquired;
    eof.child.stdin.end();
    assert.equal(await eof.stopped, 0);
    const eofBlocked = start();
    const eofReady = eofBlocked.acquired.catch(() => undefined);
    assert.equal(await eofBlocked.stopped, 10, "EOF while publisher remains live retains its durable reservation");
    await eofReady;
    assert.equal(eofBlocked.isReady(), false);
    writeFileSync(permanent, "1 12345 partial-record", "utf8");
    const corrupt = start();
    const corruptReady = corrupt.acquired.catch(() => undefined);
    assert.equal(await corrupt.stopped, 10, "interrupted or ambiguous reservation never becomes unowned");
    await corruptReady;
    assert.equal(corrupt.isReady(), false);
    assert.equal(readFileSync(permanent, "utf8"), "1 12345 partial-record", "corrupt ownership evidence must be retained");
    process.stdout.write(`Native source-cache ${process.platform} contention/cancel/live-owner/crash/restart/EOF lease passed.\n`);

    const firstReader = startReference("shared");
    const secondReader = startReference("shared");
    await Promise.all([firstReader.acquired, secondReader.acquired]);
    const exclusive = startReference("exclusive");
    const exclusiveReady = exclusive.acquired.catch(() => undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.equal(exclusive.isReady(), false, "exclusive GC reference lease must wait for live shared references");
    exclusive.child.stdin.end();
    assert.equal(await exclusive.stopped, 0, "cancelled exclusive reference wait leaves shared leases intact");
    await exclusiveReady;
    firstReader.child.stdin.end(`RELEASE ${firstReader.nonce}\n`);
    secondReader.child.stdin.end(`RELEASE ${secondReader.nonce}\n`);
    assert.deepEqual(await Promise.all([firstReader.stopped, secondReader.stopped]), [0, 0]);
    const writer = startReference("exclusive");
    await writer.acquired;
    writer.child.stdin.end(`RELEASE ${writer.nonce}\n`);
    assert.equal(await writer.stopped, 0, "exclusive GC reference lease succeeds after all readers release");
    process.stdout.write(`Native source-cache ${process.platform} shared/exclusive reference lease contention passed.\n`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    const closeResults = await Promise.all(children.map((child) => Promise.race([
      closeEvents.get(child).then(() => "closed"),
      new Promise((resolveClose) => setTimeout(() => resolveClose("timeout"), 5_000)),
    ])));
    const timedOut = children.filter((_child, index) => closeResults[index] !== "closed");
    if (timedOut.length > 0) {
      process.stderr.write(`Native fixture children did not close: ${timedOut.map((child) => child.pid ?? "unknown").join(",")}\n`);
    }
  }
}

function makeWindowsFixtureWorldWritable(directory) {
  const powershell = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl = Get-Acl -LiteralPath $path;",
    "$acl.SetAccessRuleProtection($true, $false);",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleAll($entry) };",
    "$acl.SetOwner($identity);",
    "$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl;",
    "$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit;",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: directory,
    env: { ...childEnvironment, EBB_HERMES_PROFILE_TEST_ROOT: directory },
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows unsafe-DACL fixture process should start");
  const errorText = String(result.stderr || "").replaceAll(directory, "<test-root>").trim();
  assert.equal(result.status, 0, `Windows fixture should receive an Everyone-writable DACL: ${errorText}`);
}

function makeWindowsFixtureForeignAddChildOnly(directory) {
  const powershell = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const identity = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {
    env: childEnvironment,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(identity.error, undefined, "Windows fixture identity process should start");
  assert.equal(identity.status, 0, `Windows fixture identity lookup should succeed: ${String(identity.stderr || "")}`);
  const ownerSid = String(identity.stdout || "").trim();
  assert.match(ownerSid, /^S-1-5-(?:\d+-)+\d+$/u, "Windows fixture owner identity must be a SID");
  const icacls = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "icacls.exe");
  const result = spawnSync(icacls, [directory, "/inheritance:r", "/grant:r", `*${ownerSid}:(F)`, "*S-1-1-0:(WD,AD,X,RA,RC,S)"], {
    env: childEnvironment,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows limited-add-child ACL fixture process should start");
  const errorText = `${String(result.stdout || "")} ${String(result.stderr || "")}`.replaceAll(directory, "<test-root>").trim();
  assert.equal(result.status, 0, `Windows fixture should receive only the documented non-mutating/add-child rights: ${errorText}`);
}

function makeWindowsFixtureForeignRights(directory, rightsMask) {
  const extraBits = (rightsMask & ~0x001200A6) >>> 0;
  const extraAce = new Map([
    [0x00000001, "RD"], [0x00000008, "REA"], [0x00010000, "D"], [0x00000040, "DC"],
    [0x00040000, "WDAC"], [0x00080000, "WO"], [0x80000000, "R"], [0x40000000, "W"],
    [0x20000000, "RX"], [0x10000000, "F"],
  ]).get(extraBits);
  assert.ok(extraAce, `unsupported Windows ACL test mask 0x${extraBits.toString(16)}`);
  const icacls = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "icacls.exe");
  const result = spawnSync(icacls, [directory, "/grant", `*S-1-1-0:(WD,AD,X,RA,RC,S,${extraAce})`], {
    env: childEnvironment, encoding: "utf8", shell: false, timeout: 5_000, windowsHide: true, maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows foreign-rights fixture process should start");
  const errorText = `${String(result.stdout || "")} ${String(result.stderr || "")}`.replaceAll(directory, "<test-root>").trim();
  assert.equal(result.status, 0, `Windows fixture should receive the selected foreign ACE: ${errorText}`);
}

function makeWindowsFixtureForeignReadExecute(directory, inheritOnly) {
  const powershell = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const propagation = inheritOnly
    ? "[System.Security.AccessControl.PropagationFlags]::InheritOnly"
    : "[System.Security.AccessControl.PropagationFlags]::None";
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$acl = Get-Acl -LiteralPath $path;",
    "$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');",
    "$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit;",
    `$propagation = ${propagation};`,
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, $propagation, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...childEnvironment, EBB_HERMES_PROFILE_TEST_ROOT: directory },
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows read-execute fixture process should start");
  const errorText = String(result.stderr || "").replaceAll(directory, "<test-root>").trim();
  assert.equal(result.status, 0, `Windows fixture should receive the selected foreign read-execute ACE: ${errorText}`);
}

function makeWindowsFixtureForeignDenyDelete(directory) {
  const powershell = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$acl = Get-Acl -LiteralPath $path;",
    "$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Delete, [System.Security.AccessControl.AccessControlType]::Deny);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...childEnvironment, EBB_HERMES_PROFILE_TEST_ROOT: directory },
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows deny-ACE fixture process should start");
  const errorText = String(result.stderr || "").replaceAll(directory, "<test-root>").trim();
  assert.equal(result.status, 0, `Windows fixture should receive an effective foreign delete-deny ACE: ${errorText}`);
}

function verifyWindowsAncestorAclPolicyUnit() {
  const source = join(serverDirectory, "native", "hermes-profile-path", "acl-policy-test.cpp");
  const executable = join(canonicalSandbox, "ebb-hermes-profile-path-acl-policy-test.exe");
  const objectFile = join(canonicalSandbox, "ebb-hermes-profile-path-acl-policy-test.obj");
  const { compiler, environment } = resolveWindowsMsvcEnvironment({ exists: existsSync });
  execFileSync(compiler, [
    "/nologo", "/std:c++17", "/EHsc", "/W4", "/DUNICODE", "/D_UNICODE", "/D_WIN32_WINNT=0x0A00",
    `/Fo${objectFile}`, `/Fe${executable}`, source,
  ], {
    cwd: serverDirectory,
    env: environment,
    shell: false,
    windowsHide: true,
  });
  const result = spawnSync(executable, [], {
    cwd: canonicalSandbox,
    env: childEnvironment,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 2_048,
  });
  assert.equal(result.error, undefined, "native ancestor ACL policy unit test should start");
  assert.equal(result.status, 0, `native ancestor ACL policy assertions should pass: ${String(result.stderr || "").trim()}`);
  assert.equal(result.stdout.trim(), "Native ancestor ACL policy unit cases passed.");
}

function makeWindowsFixtureFileWorldWritable(filePath) {
  const powershell = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl = Get-Acl -LiteralPath $path;",
    "$acl.SetAccessRuleProtection($true, $false);",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleAll($entry) };",
    "$acl.SetOwner($identity);",
    "$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl;",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, $rights, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...childEnvironment, EBB_HERMES_PROFILE_TEST_ROOT: filePath },
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows config-file ACL setup process should start");
  const errorText = String(result.stderr || "").replaceAll(filePath, "<test-config>").trim();
  assert.equal(result.status, 0, `Windows config.yaml should receive an Everyone-writable DACL: ${errorText}`);
}

function makeWindowsFixtureFilePrivate(filePath) {
  const powershell = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl = Get-Acl -LiteralPath $path;",
    "$acl.SetAccessRuleProtection($true, $false);",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleAll($entry) };",
    "$acl.SetOwner($identity);",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl;",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...childEnvironment, EBB_HERMES_PROFILE_TEST_ROOT: filePath },
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "Windows private config-file ACL setup process should start");
  const errorText = String(result.stderr || "").replaceAll(filePath, "<test-config>").trim();
  assert.equal(result.status, 0, `Windows config.yaml should receive a current-user-only DACL: ${errorText}`);
}

function invoke(args, input, timeout = 5_000) {
  return spawnSync(executable, args, {
    cwd: canonicalSandbox,
    env: childEnvironment,
    encoding: "utf8",
    shell: false,
    timeout,
    windowsHide: true,
    maxBuffer: 8_192,
    ...(input !== undefined ? { input } : {}),
  });
}

function verifyWindowsSafePathChainFixture(root) {
  assert.equal(process.platform, "win32", "path-chain fixture is Windows-only");
  const systemRoot = process.env.SYSTEMROOT || "C:\\Windows";
  const systemChild = join(systemRoot, "System32");
  const safeVolumeRootChain = invoke(["verify-safe-path-chain", "directory", systemChild, systemRoot]);
  assert.equal(safeVolumeRootChain.error, undefined, "safe volume-root policy fixture should start");
  assert.equal(safeVolumeRootChain.status, 0, "existing volume safe-root policy should remain accepted");
  assert.equal(safeVolumeRootChain.stderr, "", "safe volume-root chain must not emit diagnostics");
  const safeVolumeChain = JSON.parse(safeVolumeRootChain.stdout).profileHomePathChain;
  assert.equal(safeVolumeChain.authRootIndex, 1, "strict root may be the first directory after volume root");
  assert.equal(safeVolumeChain.components.length, 3, "volume-root chain contains root, strict root, and descendant identities");
  for (const identity of safeVolumeChain.components) {
    assert.match(identity.volumeSerial, /^[a-f0-9]{16}$/u);
    assert.match(identity.fileId, /^[a-f0-9]{32}$/u);
  }
  assert.equal(new Set(safeVolumeChain.components.map((identity) => identity.volumeSerial)).size, 1,
    "volume-root policy chain must retain one volume identity");
  const strictRootIdentity = invoke(["verify-safe-path", "directory", systemChild]);
  assert.equal(strictRootIdentity.status, 0, "legacy single-path identity fixture should accept the chain leaf");
  const strictRootFileIdentity = JSON.parse(strictRootIdentity.stdout);
  assert.deepEqual(safeVolumeChain.components.at(-1), {
    volumeSerial: strictRootFileIdentity.volumeSerial,
    fileId: strictRootFileIdentity.fileId,
  }, "chain terminal identity agrees with existing native path identity contract");
  const invalidBoundary = invoke(["verify-safe-path-chain", "directory", systemChild, systemChild]);
  assert.equal(invalidBoundary.error, undefined, "strict-root boundary validation should start");
  assert.equal(invalidBoundary.status, 2, "authRootIndex must be an interior chain entry, not the profile leaf");
  assert.equal(invalidBoundary.stdout, "", "invalid strict-root boundary must not emit identities");
  const invalidKind = invoke(["verify-safe-path-chain", "file", systemChild, systemRoot]);
  assert.equal(invalidKind.status, 2, "profile path-chain capture accepts directory chains only");
  assert.equal(invalidKind.stdout, "", "unsupported path-chain kinds must not emit identities");
  const systemFile = join(systemChild, "kernel32.dll");
  const invalidFileBoundary = invoke(["verify-safe-file-chain", systemFile, systemFile]);
  assert.equal(invalidFileBoundary.status, 2, "file strict root must be a proper directory ancestor, not the file leaf");
  assert.equal(invalidFileBoundary.stdout, "", "invalid file strict-root boundary must not emit identity");

  const chainParent = join(root, "path-chain-parent");
  const authRoot = join(chainParent, "auth-root");
  const profileHome = join(authRoot, "profiles", "ebb-orchestrator-run-chain-fixture");
  mkdirSync(profileHome, { recursive: true });
  for (const directory of [chainParent, authRoot, join(authRoot, "profiles"), profileHome]) {
    makeWindowsFixturePrivate(directory);
  }
  makeWindowsFixtureForeignAddChildOnly(chainParent);
  const safeChain = invoke(["verify-safe-path-chain", "directory", profileHome, authRoot]);
  assert.equal(safeChain.error, undefined, "native safe path-chain verifier should start");
  assert.equal(safeChain.status, 0,
    `foreign add-child-only ACE on an ancestor above authRoot must be accepted (${safeChain.status})`);
  assert.equal(safeChain.stderr, "", "safe path-chain verification must not emit diagnostics");
  const chainResult = JSON.parse(safeChain.stdout);
  assert.deepEqual(Object.keys(chainResult).sort(), ["profileHomePathChain", "status"].sort());
  assert.equal(chainResult.status, "SAFE_PATH_CHAIN");
  const pathChain = chainResult.profileHomePathChain;
  assert.deepEqual(Object.keys(pathChain).sort(), ["authRootIndex", "components", "version"].sort());
  assert.equal(pathChain.version, 1);
  const rootComponentCount = root.slice(3).split("\\").filter(Boolean).length;
  assert.equal(pathChain.authRootIndex, 1 + rootComponentCount + 2,
    "authRootIndex identifies the exact auth-root directory in volume-root-first order");
  assert.equal(pathChain.components.length, 1 + rootComponentCount + 4,
    "identity chain includes volume root then every component through profileHome");
  assert.ok(pathChain.components.every((identity) => {
    assert.deepEqual(Object.keys(identity).sort(), ["fileId", "volumeSerial"].sort());
    assert.match(identity.volumeSerial, /^[a-f0-9]{16}$/u);
    assert.match(identity.fileId, /^[a-f0-9]{32}$/u);
    return true;
  }));
  assert.equal(new Set(pathChain.components.map((identity) => identity.volumeSerial)).size, 1,
    "all component identities must belong to the same volume");
  assert.ok(pathChain.authRootIndex > 0 && pathChain.authRootIndex < pathChain.components.length,
    "authRootIndex is an interior component because the Run profile leaf must be beneath authRoot");

  for (const inheritOnly of [true, false]) {
    const genericParent = join(root, `path-chain-generic-${inheritOnly ? "inherit-only" : "effective"}`);
    const genericAuthRoot = join(genericParent, "auth-root");
    const genericProfile = join(genericAuthRoot, "profiles", `ebb-orchestrator-run-generic-${inheritOnly ? "inherit-only" : "effective"}`);
    mkdirSync(genericProfile, { recursive: true });
    for (const directory of [genericParent, genericAuthRoot, join(genericAuthRoot, "profiles"), genericProfile]) {
      makeWindowsFixturePrivate(directory);
    }
    makeWindowsFixtureForeignReadExecute(genericParent, inheritOnly);
    const genericResult = invoke(["verify-safe-path-chain", "directory", genericProfile, genericAuthRoot]);
    assert.equal(genericResult.error, undefined, "native read-execute path-chain verifier should start");
    if (inheritOnly) {
      assert.equal(genericResult.status, 0,
        "foreign READ|EXECUTE ACE marked INHERIT_ONLY must not apply to the current ancestor");
      assert.equal(JSON.parse(genericResult.stdout).status, "SAFE_PATH_CHAIN");
    } else {
      assert.notEqual(genericResult.status, 0,
        "the same foreign read-execute rights must remain denied when the ACE applies to the current ancestor");
      assert.equal(genericResult.stdout, "", "effective read-execute rejection must not emit an identity chain");
    }
  }

  for (const [label, deny, expectAccepted] of [
    ["deny-delete", true, true],
    ["allow-delete", false, false],
  ]) {
    const aceParent = join(root, `path-chain-ace-${label}`);
    const aceAuthRoot = join(aceParent, "auth-root");
    const aceProfile = join(aceAuthRoot, "profiles", `ebb-orchestrator-run-${label}`);
    mkdirSync(aceProfile, { recursive: true });
    for (const directory of [aceParent, aceAuthRoot, join(aceAuthRoot, "profiles"), aceProfile]) {
      makeWindowsFixturePrivate(directory);
    }
    if (deny) makeWindowsFixtureForeignDenyDelete(aceParent);
    else makeWindowsFixtureForeignRights(aceParent, 0x001200A6 | 0x00010000);
    const aceResult = invoke(["verify-safe-path-chain", "directory", aceProfile, aceAuthRoot]);
    assert.equal(aceResult.error, undefined, `${label} native path-chain verifier should start`);
    if (expectAccepted) {
      assert.equal(aceResult.status, 0, `${label} non-granting ACE must preserve accepted ancestor behavior`);
      assert.equal(JSON.parse(aceResult.stdout).status, "SAFE_PATH_CHAIN");
    } else {
      assert.notEqual(aceResult.status, 0, `${label} effective foreign ACE must fail closed`);
      assert.equal(aceResult.stdout, "", `${label} rejection must not emit a usable identity chain`);
    }
  }

  for (const [label, readOnlyRight] of [
    ["file-list-directory", 0x00000001], ["file-read-ea", 0x00000008],
  ]) {
    const readOnlyParent = join(root, `path-chain-readonly-${label}`);
    const readOnlyAuthRoot = join(readOnlyParent, "auth-root");
    const readOnlyProfile = join(readOnlyAuthRoot, "profiles", `ebb-orchestrator-run-${label}`);
    mkdirSync(readOnlyProfile, { recursive: true });
    for (const directory of [readOnlyParent, readOnlyAuthRoot, join(readOnlyAuthRoot, "profiles"), readOnlyProfile]) {
      makeWindowsFixturePrivate(directory);
    }
    makeWindowsFixtureForeignRights(readOnlyParent, 0x001200A6 | readOnlyRight);
    const acceptedReadOnly = invoke(["verify-safe-path-chain", "directory", readOnlyProfile, readOnlyAuthRoot]);
    assert.equal(acceptedReadOnly.error, undefined, `foreign ${label} ACE verifier should start`);
    assert.equal(acceptedReadOnly.status, 0,
      `foreign ${label} ACE above authRoot must be accepted as bounded read-only access (${acceptedReadOnly.status})`);
    assert.equal(acceptedReadOnly.stderr, "", `accepted foreign ${label} ACE must not emit diagnostics`);
    assert.equal(JSON.parse(acceptedReadOnly.stdout).status, "SAFE_PATH_CHAIN",
      `accepted foreign ${label} ACE must produce a validated path chain`);
  }

  const configPath = join(profileHome, "config.yaml");
  writeFileSync(configPath, "provider-free fixture\n");
  makeWindowsFixturePrivate(configPath);
  const lowercaseDriveFilePath = configPath.replace(/^([A-Z]):/iu, (_match, drive) => `${drive.toLowerCase()}:`);
  const safeFileChain = invoke(["verify-safe-file-chain", lowercaseDriveFilePath, authRoot]);
  assert.equal(safeFileChain.error, undefined, "native file path-chain verifier should start");
  assert.equal(safeFileChain.status, 0,
    `file-chain verification must accept drive-letter casing and limited ancestor rights (${safeFileChain.status})`);
  assert.equal(safeFileChain.stderr, "", "safe file-chain verification must not emit diagnostics");
  const fileIdentity = JSON.parse(safeFileChain.stdout);
  assert.deepEqual(Object.keys(fileIdentity).sort(), ["fileId", "kind", "status", "volumeSerial"].sort());
  assert.equal(fileIdentity.status, "SAFE_PATH_FILE_CHAIN");
  assert.equal(fileIdentity.kind, "file");
  assert.match(fileIdentity.volumeSerial, /^[a-f0-9]{16}$/u);
  assert.match(fileIdentity.fileId, /^[a-f0-9]{32}$/u);

  const fileReparsePath = join(profileHome, "config-reparse.yaml");
  symlinkSync(configPath, fileReparsePath, "file");
  const rejectedFileReparse = invoke(["verify-safe-file-chain", fileReparsePath, authRoot]);
  assert.equal(rejectedFileReparse.error, undefined, "native file-leaf reparse verifier should start");
  assert.notEqual(rejectedFileReparse.status, 0, "a reparse-point file leaf must be rejected");
  assert.equal(rejectedFileReparse.stdout, "", "rejected file reparse leaf must not emit an identity");
  unlinkSync(fileReparsePath);

  makeWindowsFixtureForeignAddChildOnly(profileHome);
  const unsafeStrictFileParent = invoke(["verify-safe-file-chain", configPath, authRoot]);
  assert.notEqual(unsafeStrictFileParent.status, 0,
    "foreign add-child ACE on a strict descendant directory must be rejected for a file leaf");
  assert.equal(unsafeStrictFileParent.stdout, "", "strict file-parent rejection must not emit identity");
  makeWindowsFixturePrivate(profileHome);

  for (const [label, extraRight] of [
    ["delete", 0x00010000], ["file-delete-child", 0x00000040],
    ["write-dac", 0x00040000], ["write-owner", 0x00080000],
    ["generic-read", 0x80000000], ["generic-write", 0x40000000],
    ["generic-execute", 0x20000000], ["generic-all", 0x10000000],
  ]) {
    const unsafeParent = join(root, `path-chain-unsafe-${label}`);
    const unsafeAuthRoot = join(unsafeParent, "auth-root");
    const unsafeProfile = join(unsafeAuthRoot, "profiles", `ebb-orchestrator-run-${label}`);
    mkdirSync(unsafeProfile, { recursive: true });
    for (const directory of [unsafeParent, unsafeAuthRoot, join(unsafeAuthRoot, "profiles"), unsafeProfile]) {
      makeWindowsFixturePrivate(directory);
    }
    makeWindowsFixtureForeignRights(unsafeParent, 0x001200A6 | extraRight);
    const rejected = invoke(["verify-safe-path-chain", "directory", unsafeProfile, unsafeAuthRoot]);
    assert.notEqual(rejected.status, 0, `foreign ${label} right must be rejected on a lexical ancestor`);
    assert.equal(rejected.stdout, "", `foreign ${label} rejection must not emit a usable identity chain`);
  }

  makeWindowsFixtureForeignAddChildOnly(authRoot);
  const unsafeAuthRootChain = invoke(["verify-safe-path-chain", "directory", profileHome, authRoot]);
  assert.equal(unsafeAuthRootChain.error, undefined, "unsafe auth-root chain verifier should start");
  assert.notEqual(unsafeAuthRootChain.status, 0,
    "foreign add-child ACE on authRoot itself must be rejected by strict ACL policy");
  assert.equal(unsafeAuthRootChain.stdout, "", "unsafe strict-root ACL must not emit an identity chain");
}

async function verifySourceCacheGcHandles(root) {
  const cacheRoot = join(root, "gc-cache");
  mkdirSync(cacheRoot, { mode: 0o700 });
  chmodSync(cacheRoot, 0o700);
  if (process.platform === "win32") makeWindowsFixturePrivate(cacheRoot);
  const traversalId = createHash("sha256").update(randomUUID()).digest("hex");
  const traversal = invoke(["source-cache-gc-remove", cacheRoot, traversalId], "ROOT\t1\t2\nfile\t1\t2\t../outside\n");
  assert.equal(traversal.error, undefined);
  assert.equal(traversal.status, 2, "native snapshot GC must reject traversal paths before opening any object");
  const makeCandidate = (id) => {
    const snapshotRoot = join(cacheRoot, id);
    mkdirSync(join(snapshotRoot, "pkg"), { recursive: true, mode: 0o500 });
    writeFileSync(join(snapshotRoot, "pkg", "module.py"), "pinned\n", { mode: 0o400 });
    writeFileSync(join(snapshotRoot, "top.py"), "top\n", { mode: 0o400 });
    chmodSync(join(snapshotRoot, "pkg", "module.py"), 0o400);
    chmodSync(join(snapshotRoot, "pkg"), 0o500);
    chmodSync(join(snapshotRoot, "top.py"), 0o400);
    chmodSync(snapshotRoot, 0o500);
    const sidecars = [id + ".manifest.json", id + ".native-v1.bin", `.gc-${id}.intent.json`];
    for (const name of sidecars) { writeFileSync(join(cacheRoot, name), "sidecar", { mode: 0o400 }); chmodSync(join(cacheRoot, name), 0o400); }
    const identity = (path) => { const s = lstatSync(path, { bigint: true }); return [String(s.dev), String(s.ino)]; };
    const [dev, ino] = identity(snapshotRoot);
    const rows = [`ROOT\t${dev}\t${ino}`];
    for (const [kind, path, relativePath] of [
      ["directory", join(snapshotRoot, "pkg"), "pkg"],
      ["file", join(snapshotRoot, "pkg", "module.py"), "pkg/module.py"],
      ["file", join(snapshotRoot, "top.py"), "top.py"],
    ]) { const [nodeDev, nodeIno] = identity(path); rows.push(`${kind}\t${nodeDev}\t${nodeIno}\t${relativePath}`); }
    for (const name of sidecars) { const [sideDev, sideIno] = identity(join(cacheRoot, name)); rows.push(`sidecar\t${sideDev}\t${sideIno}\t${name}`); }
    return { snapshotRoot, rows: rows.join("\n") + "\n" };
  };
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  const normal = makeCandidate(id);
  if (process.platform === "linux") {
    assert.equal(statSync(normal.snapshotRoot).mode & 0o777, 0o500, "POSIX regression must start with a sealed root directory");
    assert.equal(statSync(join(normal.snapshotRoot, "pkg")).mode & 0o777, 0o500, "POSIX regression must start with a sealed nested directory");
  }
  const removed = invoke(["source-cache-gc-remove", cacheRoot, id], normal.rows);
  assert.equal(removed.error, undefined, "native snapshot GC should start");
  assert.equal(removed.status, 0, `native snapshot GC should remove its identity-bound sealed tree: ${String(removed.stderr || "")}`);
  assert.equal(existsSync(normal.snapshotRoot), false);
  assert.equal(existsSync(join(cacheRoot, `.gc-${id}.intent.json`)), false);

  if (process.platform === "linux") {
    const preparedId = createHash("sha256").update(randomUUID()).digest("hex");
    const prepared = makeCandidate(preparedId);
    chmodSync(prepared.snapshotRoot, 0o700);
    const resumedPrepared = invoke(["source-cache-gc-remove", cacheRoot, preparedId], prepared.rows);
    assert.equal(resumedPrepared.error, undefined);
    assert.equal(resumedPrepared.status, 0, "POSIX GC must resume after a crash between directory preparation steps");
    assert.equal(existsSync(prepared.snapshotRoot), false);

    const badModeId = createHash("sha256").update(randomUUID()).digest("hex");
    const badMode = makeCandidate(badModeId);
    chmodSync(join(badMode.snapshotRoot, "pkg"), 0o750);
    const refusedMode = invoke(["source-cache-gc-remove", cacheRoot, badModeId], badMode.rows);
    assert.equal(refusedMode.error, undefined);
    assert.notEqual(refusedMode.status, 0, "POSIX GC must refuse a directory mode outside the original/intermediate set");
    assert.equal(existsSync(join(badMode.snapshotRoot, "pkg", "module.py")), true);
    assert.equal(existsSync(join(cacheRoot, badModeId + ".manifest.json")), true);
    assert.equal(existsSync(join(cacheRoot, badModeId + ".native-v1.bin")), true);
    assert.equal(existsSync(join(cacheRoot, `.gc-${badModeId}.intent.json`)), true);
  }

  const partialId = createHash("sha256").update(randomUUID()).digest("hex");
  const partial = makeCandidate(partialId);
  unlinkSync(join(partial.snapshotRoot, "top.py"));
  const recovered = invoke(["source-cache-gc-remove", cacheRoot, partialId], partial.rows);
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.status, 0, "native snapshot GC should resume idempotently after a file was already removed");
  assert.equal(existsSync(partial.snapshotRoot), false);

  const sidecarCrashId = createHash("sha256").update(randomUUID()).digest("hex");
  const sidecarCrash = makeCandidate(sidecarCrashId);
  chmodSync(join(sidecarCrash.snapshotRoot, "pkg", "module.py"), 0o600);
  chmodSync(join(sidecarCrash.snapshotRoot, "top.py"), 0o600);
  chmodSync(join(sidecarCrash.snapshotRoot, "pkg"), 0o700);
  chmodSync(sidecarCrash.snapshotRoot, 0o700);
  rmSync(sidecarCrash.snapshotRoot, { recursive: true, force: true });
  const deletedMetadata = join(cacheRoot, sidecarCrashId + ".manifest.json");
  chmodSync(deletedMetadata, 0o600);
  unlinkSync(deletedMetadata);
  const sidecarRecoveryRows = sidecarCrash.rows.split("\n")
    .filter((row) => !row.startsWith(`sidecar\t`) || !row.endsWith(sidecarCrashId + ".manifest.json")).join("\n");
  const sidecarRecovered = invoke(["source-cache-gc-remove", cacheRoot, sidecarCrashId], sidecarRecoveryRows);
  assert.equal(sidecarRecovered.error, undefined);
  assert.equal(sidecarRecovered.status, 0, "native snapshot GC must resume with root and metadata absent while projection and intent remain");
  assert.equal(existsSync(join(cacheRoot, sidecarCrashId + ".native-v1.bin")), false);
  assert.equal(existsSync(join(cacheRoot, `.gc-${sidecarCrashId}.intent.json`)), false);

  const invalidStageId = createHash("sha256").update(randomUUID()).digest("hex");
  const invalidStage = makeCandidate(invalidStageId);
  const missingProjection = join(cacheRoot, invalidStageId + ".native-v1.bin");
  chmodSync(missingProjection, 0o600);
  unlinkSync(missingProjection);
  const invalidStageRows = invalidStage.rows.split("\n")
    .filter((row) => !row.startsWith("sidecar\t") || !row.endsWith(invalidStageId + ".native-v1.bin")).join("\n");
  const refusedStage = invoke(["source-cache-gc-remove", cacheRoot, invalidStageId], invalidStageRows);
  assert.equal(refusedStage.error, undefined);
  assert.notEqual(refusedStage.status, 0, "native GC must reject a root-present state with a missing projection");
  assert.equal(readFileSync(join(invalidStage.snapshotRoot, "top.py"), "utf8"), "top\n");
  assert.equal(existsSync(join(invalidStage.snapshotRoot, "pkg", "module.py")), true);
  assert.equal(existsSync(join(invalidStage.snapshotRoot, "pkg")), true);
  assert.equal(existsSync(invalidStage.snapshotRoot), true);
  assert.equal(existsSync(join(cacheRoot, invalidStageId + ".manifest.json")), true);
  assert.equal(existsSync(join(cacheRoot, `.gc-${invalidStageId}.intent.json`)), true);

  const impossibleSidecarId = createHash("sha256").update(randomUUID()).digest("hex");
  const impossibleSidecar = makeCandidate(impossibleSidecarId);
  chmodSync(join(impossibleSidecar.snapshotRoot, "pkg", "module.py"), 0o600);
  chmodSync(join(impossibleSidecar.snapshotRoot, "top.py"), 0o600);
  chmodSync(join(impossibleSidecar.snapshotRoot, "pkg"), 0o700);
  chmodSync(impossibleSidecar.snapshotRoot, 0o700);
  rmSync(impossibleSidecar.snapshotRoot, { recursive: true, force: true });
  chmodSync(join(cacheRoot, impossibleSidecarId + ".native-v1.bin"), 0o600);
  unlinkSync(join(cacheRoot, impossibleSidecarId + ".native-v1.bin"));
  const impossibleRows = impossibleSidecar.rows.split("\n")
    .filter((row) => !row.startsWith("directory\t") && !row.startsWith("file\t") || row === "")
    .filter((row) => !row.startsWith("sidecar\t") || !row.endsWith(impossibleSidecarId + ".native-v1.bin")).join("\n");
  const refusedImpossibleSidecars = invoke(["source-cache-gc-remove", cacheRoot, impossibleSidecarId], impossibleRows);
  assert.equal(refusedImpossibleSidecars.error, undefined);
  assert.notEqual(refusedImpossibleSidecars.status, 0, "native GC must reject metadata-present/projection-missing after root removal");
  assert.equal(existsSync(join(cacheRoot, impossibleSidecarId)), false);
  assert.equal(existsSync(join(cacheRoot, impossibleSidecarId + ".manifest.json")), true);
  assert.equal(existsSync(join(cacheRoot, `.gc-${impossibleSidecarId}.intent.json`)), true);

  const makeUnicodeCandidate = (id, unicodeName) => {
    const unicodeRoot = join(cacheRoot, id);
    mkdirSync(unicodeRoot, { mode: 0o700 });
    const unicodeFile = join(unicodeRoot, unicodeName);
    writeFileSync(unicodeFile, "unicode path\n", { mode: 0o400 });
    chmodSync(unicodeFile, 0o400);
    chmodSync(unicodeRoot, 0o500);
    const sidecars = [id + ".manifest.json", id + ".native-v1.bin", `.gc-${id}.intent.json`];
    for (const name of sidecars) { writeFileSync(join(cacheRoot, name), "sidecar", { mode: 0o400 }); chmodSync(join(cacheRoot, name), 0o400); }
    const identity = (filePath) => { const info = lstatSync(filePath, { bigint: true }); return [String(info.dev), String(info.ino)]; };
    const [rootDev, rootIno] = identity(unicodeRoot);
    const [fileDev, fileIno] = identity(unicodeFile);
    const rows = [`ROOT\t${rootDev}\t${rootIno}`, `file\t${fileDev}\t${fileIno}\t${unicodeName}`];
    for (const name of sidecars) { const [dev, ino] = identity(join(cacheRoot, name)); rows.push(`sidecar\t${dev}\t${ino}\t${name}`); }
    return { id, unicodeRoot, unicodeFile, sidecars, rows };
  };
  const assertUnicodeCandidateIntact = (candidate) => {
    assert.equal(existsSync(candidate.unicodeRoot), true);
    assert.equal(existsSync(candidate.unicodeFile), true);
    for (const sidecar of candidate.sidecars) assert.equal(existsSync(join(cacheRoot, sidecar)), true);
  };
  const removeUnicodeCandidate = (candidate, message) => {
    const removed = invoke(["source-cache-gc-remove", cacheRoot, candidate.id], candidate.rows.join("\n") + "\n");
    assert.equal(removed.error, undefined);
    assert.equal(removed.status, 0, message);
    assert.equal(existsSync(candidate.unicodeRoot), false);
  };
  if (process.platform === "win32") {
    for (const [name, fileName] of [
      ["non-BMP UTF-16 boundary", "😀".repeat(120)],
      ["composed Unicode boundary", "é".repeat(240)],
      ["decomposed Unicode boundary", "e\u0301".repeat(120)],
    ]) {
      const candidate = makeUnicodeCandidate(createHash("sha256").update(randomUUID()).digest("hex"), fileName);
      removeUnicodeCandidate(candidate, `Windows native GC must preserve ${name} path units`);
    }
    const overLimit = makeUnicodeCandidate(createHash("sha256").update(randomUUID()).digest("hex"), "😀".repeat(121));
    const rejected = invoke(["source-cache-gc-remove", cacheRoot, overLimit.id], overLimit.rows.join("\n") + "\n");
    assert.equal(rejected.status, 2, "Windows GC must reject a path beyond 240 UTF-16 units before mutation");
    assertUnicodeCandidateIntact(overLimit);
  } else {
    const exactPosixBoundary = makeUnicodeCandidate(createHash("sha256").update(randomUUID()).digest("hex"), "界".repeat(85));
    assert.equal(Buffer.byteLength("界".repeat(85), "utf8"), 255);
    removeUnicodeCandidate(exactPosixBoundary, "POSIX native GC must accept a Unicode component at NAME_MAX (255 UTF-8 bytes)");
    const overLimit = makeUnicodeCandidate(createHash("sha256").update(randomUUID()).digest("hex"), "valid.py");
    const overlongName = "界".repeat(86);
    assert.equal(Buffer.byteLength(overlongName, "utf8"), 258);
    const rejected = invoke(["source-cache-gc-remove", cacheRoot, overLimit.id],
      overLimit.rows.join("\n") + `file\t1\t2\t${overlongName}\n`);
    assert.equal(rejected.status, 2, "POSIX GC must preserve the NAME_MAX 255-byte boundary");
    assertUnicodeCandidateIntact(overLimit);
  }

  const replacedId = createHash("sha256").update(randomUUID()).digest("hex");
  const replaced = makeCandidate(replacedId);
  chmodSync(join(replaced.snapshotRoot, "top.py"), 0o600);
  unlinkSync(join(replaced.snapshotRoot, "top.py"));
  writeFileSync(join(replaced.snapshotRoot, "top.py"), "replacement\n", { mode: 0o400 });
  chmodSync(join(replaced.snapshotRoot, "top.py"), 0o400);
  const refused = invoke(["source-cache-gc-remove", cacheRoot, replacedId], replaced.rows);
  assert.equal(refused.error, undefined);
  assert.notEqual(refused.status, 0, "native snapshot GC must refuse a replacement identity");
  const preflightFailures = [];
  if (readFileSync(join(replaced.snapshotRoot, "top.py"), "utf8") !== "replacement\n" ||
      !existsSync(join(replaced.snapshotRoot, "pkg", "module.py")) || !existsSync(join(replaced.snapshotRoot, "pkg")) ||
      [replacedId + ".manifest.json", replacedId + ".native-v1.bin", `.gc-${replacedId}.intent.json`]
        .some((sidecar) => !existsSync(join(cacheRoot, sidecar)))) {
    preflightFailures.push("replacement mismatch mutated expected objects before refusal");
  }

  const extraId = createHash("sha256").update(randomUUID()).digest("hex");
  const extra = makeCandidate(extraId);
  writeFileSync(join(extra.snapshotRoot, "pkg", "unexpected.py"), "unowned\n", { mode: 0o400 });
  const refusedExtra = invoke(["source-cache-gc-remove", cacheRoot, extraId], extra.rows);
  assert.equal(refusedExtra.error, undefined);
  assert.notEqual(refusedExtra.status, 0, "native snapshot GC must fail closed if an unknown object appears after prevalidation");
  if (readFileSync(join(extra.snapshotRoot, "pkg", "unexpected.py"), "utf8") !== "unowned\n" ||
      !existsSync(join(extra.snapshotRoot, "pkg", "module.py")) || !existsSync(join(extra.snapshotRoot, "top.py")) ||
      !existsSync(join(extra.snapshotRoot, "pkg")) ||
      [extraId + ".manifest.json", extraId + ".native-v1.bin", `.gc-${extraId}.intent.json`]
        .some((sidecar) => !existsSync(join(cacheRoot, sidecar)))) {
    preflightFailures.push("unknown entry mutated expected objects before refusal");
  }
  assert.deepEqual(preflightFailures, [], "native GC preflight must finish for the whole tree and sidecars before any deletion");
  assert.equal(existsSync(join(cacheRoot, `.gc-${extraId}.intent.json`)), true, "durable intent must remain for safe retry");
}

function verifySourceCacheGcInventoryBoundary(root) {
  const cacheRoot = join(root, "gc-parser-boundary");
  mkdirSync(cacheRoot, { mode: 0o700 });
  chmodSync(cacheRoot, 0o700);
  if (process.platform === "win32") makeWindowsFixturePrivate(cacheRoot);
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  const manifestPath = join(cacheRoot, `${id}.manifest.json`);
  const intentPath = join(cacheRoot, `.gc-${id}.intent.json`);
  writeFileSync(manifestPath, "metadata sentinel\n", { mode: 0o400 });
  writeFileSync(intentPath, "intent sentinel\n", { mode: 0o400 });
  const identity = (filePath) => { const info = lstatSync(filePath, { bigint: true }); return [String(info.dev), String(info.ino)]; };
  const [manifestDev, manifestIno] = identity(manifestPath);
  const [intentDev, intentIno] = identity(intentPath);
  const rows = [`ROOT\t1\t2`];
  for (let index = 0; index < 100_000; index += 1) {
    const segment = index.toString().padStart(6, "0");
    rows.push(`directory\t1\t2\td${segment}`);
    rows.push(`file\t1\t2\td${segment}/f`);
  }
  rows.push(`sidecar\t${manifestDev}\t${manifestIno}\t${id}.manifest.json`);
  rows.push(`sidecar\t1\t2\t${id}.native-v1.bin`);
  rows.push(`sidecar\t${intentDev}\t${intentIno}\t.gc-${id}.intent.json`);
  const input = rows.join("\n") + "\n";
  const inventoryBytes = Buffer.byteLength(input, "utf8");
  assert.ok(inventoryBytes <= 64 * 1024 * 1024, `200k-node inventory fits the native 64MiB parser cap (${inventoryBytes} bytes)`);
  const boundaryStartedAt = performance.now();
  const boundary = invoke(["source-cache-gc-remove", cacheRoot, id], input, 30_000);
  const boundaryDurationMs = performance.now() - boundaryStartedAt;
  assert.equal(boundary.error, undefined, "native 200k-node parser probe should start");
  assert.equal(boundary.status, 50, `native parser must accept 200k nodes plus ROOT and 3 sidecars (${inventoryBytes} bytes), then stop at the expected missing-projection preflight before deletion: ${String(boundary.stderr || "")}`);
  assert.ok(boundaryDurationMs < 20_000, `native 200k-node parser should complete under 20 seconds (actual ${Math.round(boundaryDurationMs)}ms)`);
  assert.equal(existsSync(join(cacheRoot, id)), false, "parser boundary probe has no snapshot root to delete");
  assert.equal(readFileSync(manifestPath, "utf8"), "metadata sentinel\n", "parser boundary probe must not remove metadata");
  assert.equal(readFileSync(intentPath, "utf8"), "intent sentinel\n", "parser boundary probe must not remove intent");
  assert.equal(existsSync(join(cacheRoot, `${id}.native-v1.bin`)), false, "parser boundary probe deliberately omits projection");

  const overLimitId = createHash("sha256").update(randomUUID()).digest("hex");
  const overLimitRows = [`ROOT\t1\t2`];
  for (let index = 0; index < 100_000; index += 1) overLimitRows.push(`directory\t1\t2\td${index.toString().padStart(6, "0")}`);
  for (let index = 0; index < 100_000; index += 1) overLimitRows.push(`file\t1\t2\td${index.toString().padStart(6, "0")}/f`);
  overLimitRows.push("directory\t1\t2\toverflow");
  overLimitRows.push(`sidecar\t1\t2\t${overLimitId}.manifest.json`);
  overLimitRows.push(`sidecar\t1\t2\t${overLimitId}.native-v1.bin`);
  overLimitRows.push(`sidecar\t1\t2\t.gc-${overLimitId}.intent.json`);
  const overflowInput = overLimitRows.join("\n") + "\n";
  assert.ok(Buffer.byteLength(overflowInput, "utf8") <= 64 * 1024 * 1024, "overflow fixture also fits the parser byte cap");
  const overflowStartedAt = performance.now();
  const overflow = invoke(["source-cache-gc-remove", cacheRoot, overLimitId], overflowInput, 30_000);
  const overflowDurationMs = performance.now() - overflowStartedAt;
  assert.equal(overflow.error, undefined, "native over-limit parser probe should start");
  assert.equal(overflow.status, 2, "native parser must reject 200001 nodes before filesystem processing");
  assert.ok(overflowDurationMs < 20_000, `native 200001-node rejection should complete under 20 seconds (actual ${Math.round(overflowDurationMs)}ms)`);
  process.stdout.write(`Native GC parser boundary passed: 200000 nodes (${Math.round(boundaryDurationMs)}ms), 200001 rejected (${Math.round(overflowDurationMs)}ms), ${inventoryBytes} encoded bytes.\n`);
}

if (process.platform === "win32") verifyWindowsAncestorAclPolicyUnit();

if (process.argv.includes("--path-chain-only")) {
  let primaryError;
  try {
    if (process.platform !== "win32") throw new Error("HERMES_PROFILE_PATH_CHAIN_TEST_WINDOWS_ONLY");
    makeWindowsFixturePrivate(canonicalSandbox);
    verifyWindowsSafePathChainFixture(canonicalSandbox);
  } catch (error) {
    primaryError = error;
  } finally {
    try { rmSync(canonicalSandbox, { recursive: true, force: true }); }
    catch (cleanupError) {
      if (primaryError) process.stderr.write(`Native path-chain fixture cleanup also failed: ${String(cleanupError)}\n`);
      else primaryError = cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  process.stdout.write("Native Hermes profile path-chain contract passed.\n");
} else if (process.argv.includes("--source-cache-gc-only")) {
  let primaryError;
  try {
    chmodSync(canonicalSandbox, 0o700);
    if (process.platform === "win32") makeWindowsFixturePrivate(canonicalSandbox);
    await verifySourceCacheGcHandles(canonicalSandbox);
    verifySourceCacheGcInventoryBoundary(canonicalSandbox);
  } catch (error) {
    primaryError = error;
  } finally {
    try { rmSync(canonicalSandbox, { recursive: true, force: true }); }
    catch (cleanupError) {
      if (primaryError) process.stderr.write(`Native GC fixture cleanup also failed: ${String(cleanupError)}\n`);
      else primaryError = cleanupError;
    }
  }
  if (primaryError) throw primaryError;
} else if (process.argv.includes("--source-cache-lock-only")) {
  let primaryError;
  try {
    chmodSync(canonicalSandbox, 0o700);
    if (process.platform === "win32") makeWindowsFixturePrivate(canonicalSandbox);
    await verifySourceCacheLease(canonicalSandbox);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      rmSync(canonicalSandbox, { recursive: true, force: true });
    } catch (cleanupError) {
      if (primaryError) {
        process.stderr.write(`Native fixture cleanup also failed: ${String(cleanupError)}\n`);
      } else {
        primaryError = cleanupError;
      }
    }
  }
  if (primaryError) throw primaryError;
} else {
let primaryError;
try {
  const relativeSandbox = relative(tempRoot, canonicalSandbox);
  if (isAbsolute(relativeSandbox) || relativeSandbox === ".." || relativeSandbox.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      !basename(canonicalSandbox).startsWith("ebb-hermes-profile-path-")) {
    throw new Error("HERMES_PROFILE_PATH_TEST_TEMP_OUTSIDE_SYSTEM_TEMP");
  }
  if (process.platform === "win32") makeWindowsFixturePrivate(canonicalSandbox);
  await verifySourceCacheLease(canonicalSandbox);

  const safePathTarget = join(canonicalSandbox, "identity-fixture.exe");
  writeFileSync(safePathTarget, "fixture executable identity", { encoding: "utf8" });
  if (process.platform === "win32") {
    const systemRootIdentity = invoke(["verify-safe-path", "directory", process.env.SYSTEMROOT || "C:\\Windows"]);
    assert.equal(systemRootIdentity.error, undefined, "native trusted system-root fixture should start");
    assert.equal(systemRootIdentity.status, 0, "protected system directory owner/DACL anchor should be accepted");
    const systemIdentity = JSON.parse(systemRootIdentity.stdout);
    assert.equal(systemIdentity.path, `\\\\?\\${realpathSync(process.env.SYSTEMROOT || "C:\\Windows")}`);
    assert.match(systemIdentity.volumeSerial, /^[a-f0-9]{16}$/u);
    assert.match(systemIdentity.fileId, /^[a-f0-9]{32}$/u);

    // Run this regression in the repository's ignored temp directory. Restricted Windows runners
    // may deny writes directly under USERPROFILE or assign broader ACLs to the system temp root.
    const repositoryTemp = resolve(serverDirectory, "../../temp");
    mkdirSync(repositoryTemp, { recursive: true });
    const pathChainFixtureRoot = mkdtempSync(join(repositoryTemp, "ebb-hermes-profile-chain-"));
    try {
      makeWindowsFixturePrivate(pathChainFixtureRoot);
      verifyWindowsSafePathChainFixture(pathChainFixtureRoot);
    } finally {
      rmSync(pathChainFixtureRoot, { recursive: true, force: true });
    }

    const safeDirectory = invoke(["verify-safe-path", "directory", canonicalSandbox]);
    assert.equal(safeDirectory.error, undefined, "native safe-path directory verifier should start");
    if (safeDirectory.status === 0) {
      assert.equal(safeDirectory.stderr, "", "safe-path verifier must not emit diagnostics");
      const directoryIdentity = JSON.parse(safeDirectory.stdout);
      assert.deepEqual(Object.keys(directoryIdentity).sort(), ["fileId", "kind", "path", "status", "volumeSerial"].sort());
      assert.equal(directoryIdentity.status, "SAFE_PATH");
      assert.equal(directoryIdentity.kind, "directory");
      assert.equal(directoryIdentity.path, `\\\\?\\${canonicalSandbox}`);
      assert.match(directoryIdentity.volumeSerial, /^[a-f0-9]{16}$/u);
      assert.match(directoryIdentity.fileId, /^[a-f0-9]{32}$/u);

      const safeFile = invoke(["verify-safe-path", "file", safePathTarget]);
      assert.equal(safeFile.error, undefined, "native safe-path file verifier should start");
      assert.equal(safeFile.status, 0, "owner-controlled file path should be accepted");
      const fileIdentity = JSON.parse(safeFile.stdout);
      assert.equal(fileIdentity.status, "SAFE_PATH");
      assert.equal(fileIdentity.kind, "file");
      assert.equal(fileIdentity.path, `\\\\?\\${safePathTarget}`);
      assert.match(fileIdentity.volumeSerial, /^[a-f0-9]{16}$/u);
      assert.match(fileIdentity.fileId, /^[a-f0-9]{32}$/u);

      const unsafePathRoot = join(canonicalSandbox, "unsafe-safe-path-root");
      mkdirSync(unsafePathRoot);
      makeWindowsFixtureWorldWritable(unsafePathRoot);
      const unsafeDirectory = invoke(["verify-safe-path", "directory", unsafePathRoot]);
      assert.equal(unsafeDirectory.error, undefined, "native unsafe path verifier should start");
      assert.notEqual(unsafeDirectory.status, 0, "foreign-writable directory path must be rejected");
      assert.equal(unsafeDirectory.stdout, "", "rejected safe-path verification must not emit identity");

      const junctionDestination = join(canonicalSandbox, "junction-destination");
      mkdirSync(junctionDestination);
      writeFileSync(join(junctionDestination, "existing-child.exe"), "existing child beneath the reparse component");
      const junctionTarget = join(canonicalSandbox, "safe-path-junction");
      symlinkSync(junctionDestination, junctionTarget, "junction");
      const reparsePath = invoke(["verify-safe-path", "file", join(junctionTarget, "existing-child.exe")]);
      assert.equal(reparsePath.error, undefined, "native reparse-path verifier should start");
      assert.notEqual(reparsePath.status, 0, "intermediate reparse-point components must be rejected before opening the child");
      assert.equal(reparsePath.stdout, "", "rejected reparse paths must not emit identity");
    } else if (safeDirectory.status === 41) {
      assert.fail("safe-path acceptance was not verified: native verifier exited with code 41");
    } else {
      assert.fail(`unexpected native safe-path fixture exit code ${safeDirectory.status}`);
    }
  } else if (process.platform === "linux") {
    const safeDirectory = invoke(["verify-safe-path", "directory", canonicalSandbox]);
    assert.equal(safeDirectory.error, undefined, "native POSIX safe-path directory verifier should start");
    assert.equal(safeDirectory.status, 0, `owned non-writable directory should be accepted (exit ${safeDirectory.status})`);
    assert.equal(safeDirectory.stderr, "", "POSIX safe-path verifier must not emit diagnostics");
    const directoryIdentity = JSON.parse(safeDirectory.stdout);
    assert.deepEqual(Object.keys(directoryIdentity).sort(), ["device", "inode", "path", "platform"]);
    assert.deepEqual(directoryIdentity, {
      platform: "linux",
      device: statSync(canonicalSandbox, { bigint: true }).dev.toString(),
      inode: statSync(canonicalSandbox, { bigint: true }).ino.toString(),
      path: canonicalSandbox,
    });

    const safeFile = invoke(["verify-safe-path", "file", safePathTarget]);
    assert.equal(safeFile.error, undefined, "native POSIX safe-path file verifier should start");
    assert.equal(safeFile.status, 0, `owned non-writable file should be accepted (exit ${safeFile.status})`);
    assert.equal(safeFile.stderr, "", "POSIX file verification must not emit diagnostics");
    const fileIdentity = JSON.parse(safeFile.stdout);
    assert.deepEqual(Object.keys(fileIdentity).sort(), ["device", "inode", "path", "platform"]);
    assert.deepEqual(fileIdentity, {
      platform: "linux",
      device: statSync(safePathTarget, { bigint: true }).dev.toString(),
      inode: statSync(safePathTarget, { bigint: true }).ino.toString(),
      path: safePathTarget,
    });

    const fifoPath = join(canonicalSandbox, "safe-path-fifo");
    const fifoCreation = spawnSync("mkfifo", [fifoPath], {
      cwd: canonicalSandbox,
      env: childEnvironment,
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 1_024,
    });
    assert.equal(fifoCreation.error, undefined, "mkfifo fixture creation should start and finish");
    assert.equal(fifoCreation.status, 0, `mkfifo fixture should be created (exit ${fifoCreation.status})`);
    const fifoResult = invoke(["verify-safe-path", "file", fifoPath]);
    assert.equal(fifoResult.error, undefined, "FIFO verification must finish without blocking");
    assert.notEqual(fifoResult.status, 0, "FIFO is not an acceptable regular-file identity");
    assert.equal(fifoResult.stdout, "", "FIFO rejection must not emit identity");

    const characterDeviceResult = invoke(["verify-safe-path", "file", "/dev/null"]);
    assert.equal(characterDeviceResult.error, undefined, "character-device verification must finish without opening its driver");
    assert.notEqual(characterDeviceResult.status, 0, "/dev/null is not an acceptable regular-file identity");
    assert.equal(characterDeviceResult.stdout, "", "character-device rejection must not emit identity");

    const symlinkDestination = join(canonicalSandbox, "symlink-destination");
    mkdirSync(symlinkDestination);
    const symlinkChild = join(symlinkDestination, "existing-child");
    writeFileSync(symlinkChild, "file beneath the symlinked component", { encoding: "utf8", mode: 0o600 });
    const symlinkedDirectory = join(canonicalSandbox, "safe-path-directory-link");
    symlinkSync(symlinkDestination, symlinkedDirectory, "dir");
    const intermediateLink = invoke(["verify-safe-path", "file", join(symlinkedDirectory, "existing-child")]);
    assert.equal(intermediateLink.error, undefined, "intermediate symlink verifier should start");
    assert.notEqual(intermediateLink.status, 0, "intermediate symlink components must be rejected");
    assert.equal(intermediateLink.stdout, "", "intermediate symlink rejection must not emit identity");

    const finalDirectoryLink = invoke(["verify-safe-path", "directory", symlinkedDirectory]);
    assert.equal(finalDirectoryLink.error, undefined, "final directory symlink verifier should start");
    assert.notEqual(finalDirectoryLink.status, 0, "final directory symlinks must be rejected");
    assert.equal(finalDirectoryLink.stdout, "", "final directory symlink rejection must not emit identity");

    const symlinkedFile = join(canonicalSandbox, "safe-path-file-link");
    symlinkSync(safePathTarget, symlinkedFile, "file");
    const finalLink = invoke(["verify-safe-path", "file", symlinkedFile]);
    assert.equal(finalLink.error, undefined, "final symlink verifier should start");
    assert.notEqual(finalLink.status, 0, "final symlink components must be rejected");
    assert.equal(finalLink.stdout, "", "final symlink rejection must not emit identity");

    const unsafeDirectory = join(canonicalSandbox, "unsafe-safe-path-directory");
    mkdirSync(unsafeDirectory);
    chmodSync(unsafeDirectory, 0o777);
    const unsafeDirectoryResult = invoke(["verify-safe-path", "directory", unsafeDirectory]);
    assert.equal(unsafeDirectoryResult.error, undefined, "unsafe directory verifier should start");
    assert.notEqual(unsafeDirectoryResult.status, 0, "group/world-writable directories must be rejected");
    assert.equal(unsafeDirectoryResult.stdout, "", "unsafe directory rejection must not emit identity");

    const unsafeFile = join(canonicalSandbox, "unsafe-safe-path-file");
    writeFileSync(unsafeFile, "group/world writable", { encoding: "utf8", mode: 0o600 });
    chmodSync(unsafeFile, 0o666);
    const unsafeFileResult = invoke(["verify-safe-path", "file", unsafeFile]);
    assert.equal(unsafeFileResult.error, undefined, "unsafe file verifier should start");
    assert.notEqual(unsafeFileResult.status, 0, "group/world-writable files must be rejected");
    assert.equal(unsafeFileResult.stdout, "", "unsafe file rejection must not emit identity");
  } else {
    const unsupported = invoke(["verify-safe-path", "file", safePathTarget]);
    assert.equal(unsupported.error, undefined, "unsupported native safe-path verifier should start");
    assert.notEqual(unsupported.status, 0, "platform without handle-bound identity must fail closed");
    assert.equal(unsupported.stdout, "", "unsupported platform must not emit a fake path identity");
  }

  const hermesRoot = join(canonicalSandbox, "hermes-root");
  mkdirSync(hermesRoot);
  const runId = "c9b640db-9fbf-4d1f-b8a8-91e74093772b";
  const created = invoke(["create-profile", hermesRoot, runId]);
  assert.equal(created.error, undefined, "native create-profile process should start");
  assert.equal(created.status, 0, `native create-profile should create a private profile (exit ${created.status}, ${String(created.stderr).trim()})`);
  const profile = join(hermesRoot, "profiles", `ebb-orchestrator-run-${runId}`);
  const expectedProfile = join(hermesRoot, "profiles", `ebb-orchestrator-run-${runId}`);
  assert.equal(profile, expectedProfile);
  assert.equal(lstatSync(profile).isDirectory(), true);

  const projectRoot = join(canonicalSandbox, "hermes-install");
  mkdirSync(projectRoot);

  const duplicate = invoke(["create-profile", hermesRoot, runId]);
  assert.equal(duplicate.error, undefined, "native duplicate create process should start");
  assert.notEqual(duplicate.status, 0, "native helper must not reuse or overwrite an existing profile");

  const unsafeId = invoke(["create-profile", hermesRoot, "../outside"]);
  assert.equal(unsafeId.error, undefined, "native unsafe-id process should start");
  assert.notEqual(unsafeId.status, 0, "native helper must reject path traversal in Run ID");
  assert.equal(lstatSync(profile).isDirectory(), true, "unsafe Run ID must not alter the existing profile");

  const uppercaseRunId = "A1111111-1111-4111-8111-111111111111";
  const nonCanonicalUuid = invoke(["create-profile", hermesRoot, uppercaseRunId]);
  assert.equal(nonCanonicalUuid.error, undefined, "native non-canonical UUID process should start");
  assert.notEqual(nonCanonicalUuid.status, 0, "native helper must reject a non-canonical UUID Run ID");
  assert.equal(existsSync(join(hermesRoot, "profiles", `ebb-orchestrator-run-${uppercaseRunId}`)), false,
    "invalid UUID must be rejected before any profile directory is created");

  const preservedContentPath = join(profile, "rollback-marker");
  writeFileSync(preservedContentPath, "preserve non-empty profile", { encoding: "utf8", mode: 0o600 });
  const nonEmptyCleanup = invoke(["cleanup-profile", hermesRoot, runId]);
  assert.equal(nonEmptyCleanup.error, undefined, "native cleanup of a non-empty profile should start");
  assert.notEqual(nonEmptyCleanup.status, 0, "native cleanup must refuse a non-empty Run profile");
  assert.equal(existsSync(preservedContentPath), true, "refused cleanup must preserve all unexpected content");
  rmSync(preservedContentPath);
  const cleaned = invoke(["cleanup-profile", hermesRoot, runId]);
  assert.equal(cleaned.error, undefined, "native cleanup of the exact empty profile should start");
  assert.equal(cleaned.status, 0, "native cleanup should remove the exact empty Run profile");
  assert.equal(existsSync(profile), false, "native cleanup should remove only the Run-owned profile leaf");
  const cleanedAgain = invoke(["cleanup-profile", hermesRoot, runId]);
  assert.equal(cleanedAgain.error, undefined, "idempotent cleanup should start");
  assert.equal(cleanedAgain.status, 0, "cleanup of an absent Run profile should be idempotent");
  assert.equal(existsSync(join(hermesRoot, "profiles")), true, "cleanup must preserve shared profiles/ parent");

  if (process.platform === "win32") {
    const unsafeRoot = join(canonicalSandbox, "unsafe-dacl-root");
    mkdirSync(unsafeRoot);
    makeWindowsFixtureWorldWritable(unsafeRoot);
    const unsafeDaclRunId = "36d2c7f4-4209-4d7b-9f10-51dd081a2a73";
    const unsafeDacl = invoke(["create-profile", unsafeRoot, unsafeDaclRunId]);
    assert.equal(unsafeDacl.error, undefined, "native unsafe-DACL process should start");
    assert.notEqual(unsafeDacl.status, 0, "native helper must reject an unsafe writable root DACL");
    assert.equal(existsSync(join(unsafeRoot, "profiles")), false, "unsafe root DACL must be rejected before creating profiles/");

    const junctionRoot = join(canonicalSandbox, "hermes-root-junction");
    symlinkSync(hermesRoot, junctionRoot, "junction");
    assert.equal(lstatSync(junctionRoot).isSymbolicLink(), true, "junction fixture must be a Windows reparse point");
    const reparseRunId = "4e39c2a6-2e8b-4b47-9802-3d43cf22d405";
    const reparse = invoke(["create-profile", junctionRoot, reparseRunId]);
    assert.equal(reparse.error, undefined, "native reparse-point process should start");
    assert.notEqual(reparse.status, 0, "native helper must reject a reparse-point root component");
    assert.equal(existsSync(join(hermesRoot, "profiles", `ebb-orchestrator-run-${reparseRunId}`)), false,
      "reparse-point root must be rejected before modifying its target");

    const existingConfigRunId = "6882dca1-bde3-4ced-9c72-57ba8d2e3d4b";
    const existingConfigProfileCreate = invoke(["create-profile", hermesRoot, existingConfigRunId]);
    assert.equal(existingConfigProfileCreate.error, undefined, "existing-config profile setup should start");
    assert.equal(existingConfigProfileCreate.status, 0, "existing-config profile setup should succeed");
    const existingConfigPath = join(hermesRoot, "profiles", `ebb-orchestrator-run-${existingConfigRunId}`, "config.yaml");
    const existingConfigContents = "preexisting Run config must not be replaced\n";
    writeFileSync(existingConfigPath, existingConfigContents, { encoding: "utf8", mode: 0o600 });
    const attemptedOverwrite = invoke(
      ["initialize-run-profile", hermesRoot, existingConfigRunId],
      "model:\n  provider: fireworks\n  default: example\n",
    );
    assert.equal(attemptedOverwrite.error, undefined, "existing-config writer process should start");
    assert.notEqual(attemptedOverwrite.status, 0, "native writer must refuse an existing config.yaml");
    assert.equal(readFileSync(existingConfigPath, "utf8"), existingConfigContents,
      "existing config.yaml must remain unchanged");
  } else if (process.platform === "linux") {
    const linuxConfigRunId = "ee2631f1-f1e5-48a2-8fc8-e7456a1f560e";
    const linuxProfileCreate = invoke(["create-profile", hermesRoot, linuxConfigRunId]);
    assert.equal(linuxProfileCreate.error, undefined, "POSIX config profile setup should start");
    assert.equal(linuxProfileCreate.status, 0, "POSIX config profile setup should create the exact private Run profile");
    const linuxProfile = join(hermesRoot, "profiles", `ebb-orchestrator-run-${linuxConfigRunId}`);
    const linuxConfigPath = join(linuxProfile, "config.yaml");
    const linuxConfigContents = "model:\n  provider: openai-api\n  default: gpt-6-luna\n";
    const initializeLinuxProfile = invoke(
      ["initialize-run-profile", hermesRoot, linuxConfigRunId], linuxConfigContents,
    );
    assert.equal(initializeLinuxProfile.error, undefined, "POSIX Run profile writer should start");
    assert.equal(initializeLinuxProfile.status, 0, "POSIX Run profile writer should initialize exact home and config");
    assert.equal(statSync(join(linuxProfile, "home")).mode & 0o777, 0o700, "POSIX Run home must stay private");
    assert.equal(statSync(linuxConfigPath).mode & 0o777, 0o600, "POSIX Run config must stay private");
    assert.equal(readFileSync(linuxConfigPath, "utf8"), linuxConfigContents);

    const attemptedLinuxOverwrite = invoke(
      ["initialize-run-profile", hermesRoot, linuxConfigRunId], "model:\n  provider: changed\n",
    );
    assert.equal(attemptedLinuxOverwrite.error, undefined, "POSIX existing-config writer should start and refuse safely");
    assert.notEqual(attemptedLinuxOverwrite.status, 0, "POSIX writer must refuse an existing config.yaml");
    assert.equal(readFileSync(linuxConfigPath, "utf8"), linuxConfigContents,
      "POSIX existing config.yaml must remain unchanged");
  }

  const configHome = join(canonicalSandbox, "selection-home");
  mkdirSync(configHome);
  if (process.platform === "win32") makeWindowsFixturePrivate(configHome);
  const plannedRunId = "b3f30ef0-d54d-4ac8-b913-9a8d2584b120";
  const plannedProfileHome = join(configHome, "profiles", `ebb-orchestrator-run-${plannedRunId}`);
  const selectionArgs = ["project-selection", configHome, plannedProfileHome, plannedRunId];
  const configPath = join(configHome, "config.yaml");
  const unrelatedMarker = "UNRELATED_CONFIG_VALUE_MUST_NOT_LEAK";
  writeFileSync(configPath, ["description: " + unrelatedMarker, "model:", "  provider: openai-api", "  default: gpt-6-luna", ""].join("\n"), {
    encoding: "utf8", mode: 0o600,
  });
  const pinnedDefault = "https://api.openai.com/v1";
  const projectDotEnv = join(projectRoot, ".env");
  const profileDotEnv = join(plannedProfileHome, ".env");
  const endpointArgs = ["project-endpoint", configHome, plannedProfileHome, projectRoot, "openai-api", "gpt-6-luna", "OPENAI_BASE_URL", plannedRunId];
  const endpointInput = (value) => value === undefined
    ? "0\n0\n"
    : `1\n${Buffer.byteLength(value, "utf8")}\n${value}`;
  const endpointProjection = (value) => invoke(endpointArgs, endpointInput(value));
  const expectSelectionUnavailable = (result, note, reason = "HERMES_SELECTION_PROFILE_UNAVAILABLE") => {
    assert.equal(result.error, undefined, `${note}: native selection projection should start`);
    assert.equal(result.status, 0, `${note}: fail-closed selection result should be data`);
    assert.equal(result.stderr, "", `${note}: selection data must not be logged`);
    assert.deepEqual(JSON.parse(result.stdout), {
      sourceVersion: "v0.21.5+7357.g9244275",
      sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
      projectionVersion: "hermes-config-selection-v1",
      status: "UNAVAILABLE",
      reason,
      endpointOverridePresent: false,
    });
  };
  const expectPinnedEndpoint = (result, note) => {
    assert.equal(result.error, undefined, `${note}: native endpoint projection should start`);
    assert.equal(result.status, 0, `${note}: endpoint projection should complete as data`);
    assert.equal(result.stderr, "", `${note}: endpoint projection must not log values`);
    assert.deepEqual(JSON.parse(result.stdout), {
      sourceVersion: "v0.21.5+7357.g9244275",
      sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
      projectionVersion: "hermes-endpoint-projection-v1",
      status: "PINNED_DEFAULT",
      providerId: "openai-api",
      baseUrlEnvVar: "OPENAI_BASE_URL",
    });
    assert.equal(result.stdout.includes(pinnedDefault), false, `${note}: endpoint must not be emitted`);
    assert.equal(result.stdout.includes(unrelatedMarker), false, `${note}: unrelated config value must not be emitted`);
  };
  const expectEndpointUnavailable = (result, note, forbiddenValue) => {
    assert.equal(result.error, undefined, `${note}: native endpoint projection should start`);
    assert.equal(result.status, 0, `${note}: fail-closed result should be data`);
    assert.equal(result.stderr, "", `${note}: endpoint projection must not log values`);
    assert.deepEqual(JSON.parse(result.stdout), {
      sourceVersion: "v0.21.5+7357.g9244275",
      sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
      projectionVersion: "hermes-endpoint-projection-v1",
      status: "UNAVAILABLE",
      reason: "HERMES_ENDPOINT_ID_UNAVAILABLE",
    });
    if (forbiddenValue) assert.equal(result.stdout.includes(forbiddenValue), false, `${note}: endpoint value must not be emitted`);
  };

  assert.equal(existsSync(join(configHome, "profiles")), false, "planned-profile projection must start before profiles/ exists");
  const selected = invoke(selectionArgs);
  assert.equal(selected.error, undefined, "native Run-bound project-selection process should start");
  assert.equal(selected.status, 0, "native Run-bound project-selection should complete as data");
  assert.deepEqual(JSON.parse(selected.stdout), {
    sourceVersion: "v0.21.5+7357.g9244275",
    sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
    projectionVersion: "hermes-config-selection-v1",
    status: "EXPLICIT_SELECTION",
    providerId: "openai-api",
    modelId: "gpt-6-luna",
    endpointOverridePresent: false,
  });
  expectSelectionUnavailable(invoke([
    "project-selection", configHome,
    join(configHome, "profiles", "ebb-orchestrator-run-c9b640db-9fbf-4d1f-b8a8-91e74093772b"), plannedRunId,
  ]), "project-selection profile bound to another Run UUID");
  expectPinnedEndpoint(endpointProjection(undefined), "planned missing profile path before native profile creation");
  assert.equal(existsSync(join(configHome, "profiles")), false, "planned-profile projection must not create profiles/");

  const wrongRoot = join(canonicalSandbox, "wrong-selection-home");
  mkdirSync(wrongRoot);
  if (process.platform === "win32") makeWindowsFixturePrivate(wrongRoot);
  const wrongRootResult = invoke([
    "project-endpoint", configHome, join(wrongRoot, "profiles", `ebb-orchestrator-run-${plannedRunId}`),
    projectRoot, "openai-api", "gpt-6-luna", "OPENAI_BASE_URL", plannedRunId,
  ], endpointInput(undefined));
  expectEndpointUnavailable(wrongRootResult, "planned profile under a different Hermes root");

  const wrongRunId = "c9b640db-9fbf-4d1f-b8a8-91e74093772b";
  const wrongLeafResult = invoke([
    "project-endpoint", configHome, join(configHome, "profiles", `ebb-orchestrator-run-${wrongRunId}`),
    projectRoot, "openai-api", "gpt-6-luna", "OPENAI_BASE_URL", plannedRunId,
  ], endpointInput(undefined));
  expectEndpointUnavailable(wrongLeafResult, "planned profile leaf bound to another Run UUID");

  const profilesTarget = join(canonicalSandbox, "profiles-symlink-target");
  mkdirSync(profilesTarget);
  if (process.platform === "win32") makeWindowsFixturePrivate(profilesTarget);
  symlinkSync(profilesTarget, join(configHome, "profiles"), process.platform === "win32" ? "junction" : "dir");
  expectEndpointUnavailable(endpointProjection(undefined), "planned profiles directory is a symlink or reparse point");
  rmSync(join(configHome, "profiles"), { force: true });
  assert.equal(existsSync(join(configHome, "profiles")), false, "rejected profiles reparse fixture must be removed");

  expectPinnedEndpoint(endpointProjection(undefined), "no dotenv or explicit endpoint override");
  assert.equal(existsSync(join(configHome, "profiles")), false, "missing-profile projection remains read-only");

  if (process.platform === "win32") {
    const unsafeConfigHome = join(canonicalSandbox, "unsafe-selection-root");
    mkdirSync(unsafeConfigHome);
    makeWindowsFixtureWorldWritable(unsafeConfigHome);
    const safeConfigInUnsafeRoot = join(unsafeConfigHome, "config.yaml");
    writeFileSync(safeConfigInUnsafeRoot, "model:\n  provider: fireworks\n  default: example/model\n", "utf8");
    makeWindowsFixtureFilePrivate(safeConfigInUnsafeRoot);
    const unsafeRootSelection = invoke([
      "project-selection", unsafeConfigHome,
      join(unsafeConfigHome, "profiles", `ebb-orchestrator-run-${plannedRunId}`), plannedRunId,
    ]);
    expectSelectionUnavailable(unsafeRootSelection, "unsafe Hermes config root DACL", "HERMES_SELECTION_CONFIG_UNSUPPORTED");

    const unsafeFileHome = join(canonicalSandbox, "unsafe-selection-file");
    mkdirSync(unsafeFileHome);
    const unsafeConfigPath = join(unsafeFileHome, "config.yaml");
    writeFileSync(unsafeConfigPath, "model:\n  provider: fireworks\n  default: example/model\n", "utf8");
    makeWindowsFixtureFileWorldWritable(unsafeConfigPath);
    const unsafeFileSelection = invoke([
      "project-selection", unsafeFileHome,
      join(unsafeFileHome, "profiles", `ebb-orchestrator-run-${plannedRunId}`), plannedRunId,
    ]);
    expectSelectionUnavailable(unsafeFileSelection, "config.yaml writable by an untrusted principal", "HERMES_SELECTION_CONFIG_UNSUPPORTED");
  }

  const plannedProfileCreation = invoke(["create-profile", configHome, plannedRunId]);
  assert.equal(plannedProfileCreation.error, undefined, "native planned-profile creation should start");
  assert.equal(plannedProfileCreation.status, 0, "native helper should create the exact planned Run profile");
  assert.equal(lstatSync(plannedProfileHome).isDirectory(), true, "exact planned leaf should exist after explicit creation");
  expectPinnedEndpoint(endpointProjection(undefined), "existing private empty Run profile");

  expectPinnedEndpoint(endpointProjection(pinnedDefault), "explicit child endpoint equals source literal");
  writeFileSync(projectDotEnv, `OPENAI_BASE_URL=${pinnedDefault}\n`, { encoding: "utf8", mode: 0o600 });
  expectPinnedEndpoint(endpointProjection(undefined), "installation dotenv equals source literal");

  const customEndpoint = "https://private.example.invalid/custom-path";
  writeFileSync(projectDotEnv, `OPENAI_BASE_URL=${customEndpoint}\n`, { encoding: "utf8", mode: 0o600 });
  expectEndpointUnavailable(endpointProjection(undefined), "custom installation endpoint", customEndpoint);
  expectEndpointUnavailable(endpointProjection(pinnedDefault), "installation dotenv overrides explicit child endpoint without profile dotenv", customEndpoint);

  writeFileSync(profileDotEnv, "", { encoding: "utf8", mode: 0o600 });
  expectPinnedEndpoint(endpointProjection(pinnedDefault), "explicit child endpoint wins over installation fallback when profile dotenv exists");
  writeFileSync(profileDotEnv, `OPENAI_BASE_URL=${pinnedDefault}\n`, { encoding: "utf8", mode: 0o600 });
  expectPinnedEndpoint(endpointProjection("https://different.example.invalid"), "profile dotenv overrides explicit child endpoint");
  writeFileSync(profileDotEnv, `OPENAI_BASE_URL=${customEndpoint}\n`, { encoding: "utf8", mode: 0o600 });
  expectEndpointUnavailable(endpointProjection(pinnedDefault), "profile dotenv overrides child endpoint", customEndpoint);

  writeFileSync(profileDotEnv, `OPENAI_BASE_URL=${pinnedDefault}\nOPENAI_BASE_URL=${pinnedDefault}\n`, {
    encoding: "utf8", mode: 0o600,
  });
  expectEndpointUnavailable(endpointProjection(undefined), "duplicate selected endpoint key", pinnedDefault);
  writeFileSync(profileDotEnv, "OPENAI_BASE_URL=${UPSTREAM_URL}\n", { encoding: "utf8", mode: 0o600 });
  expectEndpointUnavailable(endpointProjection(undefined), "interpolated selected endpoint value");

  rmSync(profileDotEnv, { force: true });
  const profileOpDotEnv = join(plannedProfileHome, ".op.env");
  writeFileSync(profileOpDotEnv, "fixture=unsupported-layer\n", { encoding: "utf8", mode: 0o600 });
  expectEndpointUnavailable(endpointProjection(undefined), "profile .op.env layer exists");
  rmSync(profileOpDotEnv);

  const profileConfigPath = join(plannedProfileHome, "config.yaml");
  writeFileSync(profileConfigPath, "fixture: orchestrator-generated-config\n", { encoding: "utf8", mode: 0o600 });
  expectEndpointUnavailable(endpointProjection(undefined), "profile config.yaml already exists");
  rmSync(profileConfigPath);

  if (process.platform === "linux") {
    rmSync(profileDotEnv, { force: true });
    const outsideDotEnv = join(canonicalSandbox, "outside.env");
    writeFileSync(outsideDotEnv, `OPENAI_BASE_URL=${pinnedDefault}\n`, { encoding: "utf8", mode: 0o600 });
    symlinkSync(outsideDotEnv, profileDotEnv);
    expectEndpointUnavailable(endpointProjection(undefined), "profile dotenv symlink");
    rmSync(profileDotEnv);
  }

  const endpoint = "https://private.example.invalid/v1";
  writeFileSync(configPath, [
    "model:",
    "  provider: example-provider",
    "  default: vendor/model-v1",
    `  base_url: '${endpoint}'`,
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });

  const projectionResult = invoke(selectionArgs);
  assert.equal(projectionResult.error, undefined, "native project-selection process should start");
  assert.equal(projectionResult.status, 0, "native bounded projection should finish");
  assert.equal(projectionResult.stderr, "", `native projection must not log config data: ${String(projectionResult.stderr).trim()}`);
  const projection = JSON.parse(projectionResult.stdout);
  assert.deepEqual(projection, {
    sourceVersion: "v0.21.5+7357.g9244275",
    sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
    projectionVersion: "hermes-config-selection-v1",
    status: "EXPLICIT_SELECTION",
    providerId: "example-provider",
    modelId: "vendor/model-v1",
    endpointOverridePresent: true,
  });
  assert.equal(projectionResult.stdout.includes(endpoint), false, "native projection must never expose endpoint URL");
  assert.equal(projectionResult.stdout.includes(unrelatedMarker), false, "native projection must never expose unrelated config values");

  writeFileSync(join(configHome, "config.yaml"), [
    "model:",
    "  provider: openai-api",
    "  default: gpt-6-luna",
    "  api_mode: openai_chat",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  const unsupported = invoke(selectionArgs);
  assert.equal(unsupported.error, undefined, "native unsupported-layer check should start");
  assert.equal(unsupported.status, 0, "native unsupported-layer check should fail closed as data");
  assert.deepEqual(JSON.parse(unsupported.stdout), {
    sourceVersion: "v0.21.5+7357.g9244275",
    sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
    projectionVersion: "hermes-config-selection-v1",
    status: "UNAVAILABLE",
    reason: "HERMES_SELECTION_CONFIG_UNSUPPORTED",
    endpointOverridePresent: false,
  });
  assert.equal(unsupported.stderr, "", "unsupported fields must not be logged");

  for (const unsupportedLayer of ["secrets", "plugins"]) {
    writeFileSync(configPath, [
      "model:",
      "  provider: openai-api",
      "  default: gpt-6-luna",
      `${unsupportedLayer}:`,
      "  fixture: unsupported-layer",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    const unsupportedConfigLayer = invoke(selectionArgs);
    assert.equal(unsupportedConfigLayer.error, undefined, `${unsupportedLayer} layer check should start`);
    assert.equal(unsupportedConfigLayer.status, 0, `${unsupportedLayer} layer must fail closed as data`);
    assert.deepEqual(JSON.parse(unsupportedConfigLayer.stdout), {
      sourceVersion: "v0.21.5+7357.g9244275",
      sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
      projectionVersion: "hermes-config-selection-v1",
      status: "UNAVAILABLE",
      reason: "HERMES_SELECTION_CONFIG_UNSUPPORTED",
      endpointOverridePresent: false,
    });
    assert.equal(unsupportedConfigLayer.stderr, "", `${unsupportedLayer} config data must not be logged`);
  }
  process.stdout.write(`Native Hermes profile-path ${process.platform} fixture contract passed.\n`);
} catch (error) {
  primaryError = error;
} finally {
  try {
    rmSync(canonicalSandbox, { recursive: true, force: true });
  } catch (cleanupError) {
    if (primaryError) {
      process.stderr.write(`Native fixture cleanup also failed: ${String(cleanupError)}\n`);
    } else {
      primaryError = cleanupError;
    }
  }
}
if (primaryError) throw primaryError;
}
