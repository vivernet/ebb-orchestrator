import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import console from "node:console";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("WINDOWS_TARGET_ACCEPTANCE_REQUIRES_WINDOWS");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(serverDirectory, "..", "..");
const buildScript = join(scriptDirectory, "build-windows-run-supervisor.mjs");
const executable = join(serverDirectory, "dist", "native", "windows-run-supervisor", "ebb-run-supervisor-frame-test.exe");
execFileSync(process.execPath, [buildScript, "--frame-acceptance"], {
  cwd: repositoryDirectory, shell: false, stdio: "inherit", windowsHide: true,
});

const sandbox = mkdtempSync(join(realpathSync(tmpdir()), "ebb-target-handles-"));
let activeChild;

function runPowerShell(command, extraEnvironment = {}) {
  const executablePath = join(process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFileSync(executablePath, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: repositoryDirectory, shell: false, stdio: "ignore", windowsHide: true,
    env: { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows", EBB_TARGET_SANDBOX: sandbox, ...extraEnvironment },
  });
}

function protectPrivateFixtureObject(pathname) {
  runPowerShell([
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_TARGET_OBJECT');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl = Get-Acl -LiteralPath $path;",
    "$acl.SetOwner($identity);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" "), { EBB_TARGET_OBJECT: pathname });
}

function identityVector(path) {
  const result = spawnSync(executable, ["identify-targets", path], {
    cwd: repositoryDirectory, encoding: "utf8", env: { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" },
    shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 4_096,
  });
  assert.equal(result.error, undefined, "native identity projection should start");
  assert.equal(result.status, 0, `native target identity projection should pass: ${result.stdout}`);
  const fields = result.stdout.trim().split("\t");
  assert.equal(fields.length, 5);
  assert.equal(fields[0], "TARGETS");
  return fields.slice(1);
}

function waitLine(child, expected) {
  return new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`native helper did not emit ${expected}`)), 5_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) { clearTimeout(timer); resolveLine(output); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      if (!output.includes(expected)) { clearTimeout(timer); reject(new Error(`native helper exited ${code}: ${output}`)); }
    });
  });
}

try {
  runPowerShell([
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_TARGET_SANDBOX');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl = Get-Acl -LiteralPath $path;",
    "$acl.SetAccessRuleProtection($true, $false);",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleAll($entry) };",
    "$acl.SetOwner($identity);",
    "$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit;",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" "));

  const prepareFixture = (name) => {
    const fixtureProfile = join(sandbox, name, "ebb-orchestrator-run-123e4567-e89b-42d3-a456-426614174000");
    const fixtureHome = join(fixtureProfile, "home");
    const fixtureConfig = join(fixtureProfile, "config.yaml");
    const fixtureReplacement = join(fixtureProfile, "replacement.yaml");
    mkdirSync(fixtureHome, { recursive: true });
    writeFileSync(fixtureConfig, "model:\n  provider: fixture\n  default: fixture\n", { flag: "wx" });
    writeFileSync(fixtureReplacement, "fixture replacement\n", { flag: "wx" });
    protectPrivateFixtureObject(fixtureProfile);
    protectPrivateFixtureObject(fixtureHome);
    protectPrivateFixtureObject(fixtureConfig);
    protectPrivateFixtureObject(fixtureReplacement);
    return { fixtureProfile, fixtureHome, fixtureConfig, fixtureReplacement };
  };

  function startHolder(fixture, ids) {
    const [homeVolume, homeFile, configVolume, configFile] = ids;
    const child = activeChild = spawn(executable, ["hold-targets", fixture.fixtureProfile, homeVolume, homeFile, configVolume, configFile], {
      cwd: repositoryDirectory, shell: false, windowsHide: true,
      env: { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    return { child, getStderr: () => stderr };
  }

  async function assertStaleTicketRejected(name, mutate) {
    const fixture = prepareFixture(name);
    const ids = identityVector(fixture.fixtureProfile);
    mutate(fixture);
    const [homeVolume, homeFile, configVolume, configFile] = ids;
    const result = spawnSync(executable, ["hold-targets", fixture.fixtureProfile, homeVolume, homeFile, configVolume, configFile], {
      cwd: repositoryDirectory, encoding: "utf8", env: { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" },
      shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 4_096,
    });
    assert.equal(result.error, undefined, `${name}: native target validation process should start`);
    assert.notEqual(result.status, 0, `${name}: a stale target identity/reparse/ACL must fail closed`);
  }

  const fixture = prepareFixture("wrong-identities");
  const [homeVolume, homeFile, configVolume, configFile] = identityVector(fixture.fixtureProfile);
  const wrongHome = spawnSync(executable, ["hold-targets", fixture.fixtureProfile, homeVolume, "f".repeat(32), configVolume, configFile], {
    cwd: repositoryDirectory, encoding: "utf8", env: { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" },
    shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 4_096,
  });
  assert.notEqual(wrongHome.status, 0, "wrong home directory identity must fail before target handles are accepted");
  const wrongConfig = spawnSync(executable, ["hold-targets", fixture.fixtureProfile, homeVolume, homeFile, configVolume, "e".repeat(32)], {
    cwd: repositoryDirectory, encoding: "utf8", env: { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" },
    shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 4_096,
  });
  assert.notEqual(wrongConfig.status, 0, "wrong config.yaml identity must fail before target handles are accepted");

  await assertStaleTicketRejected("home-swap", ({ fixtureHome }) => {
    renameSync(fixtureHome, `${fixtureHome}.old`);
    mkdirSync(fixtureHome);
  });
  await assertStaleTicketRejected("home-junction", ({ fixtureHome }) => {
    const backup = `${fixtureHome}.old`;
    renameSync(fixtureHome, backup);
    mkdirSync(join(sandbox, "junction-target"));
    execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", fixtureHome, join(sandbox, "junction-target")], {
      cwd: repositoryDirectory, shell: false, stdio: "ignore", windowsHide: true,
    });
  });
  await assertStaleTicketRejected("config-delete", ({ fixtureConfig }) => unlinkSync(fixtureConfig));
  await assertStaleTicketRejected("config-replace", ({ fixtureConfig }) => {
    renameSync(fixtureConfig, `${fixtureConfig}.old`);
    writeFileSync(fixtureConfig, "replacement config\n", { flag: "wx" });
  });
  await assertStaleTicketRejected("config-hardlink", ({ fixtureConfig, fixtureReplacement }) => {
    unlinkSync(fixtureConfig);
    linkSync(fixtureReplacement, fixtureConfig);
  });
  await assertStaleTicketRejected("home-acl-change", ({ fixtureHome }) => {
    runPowerShell([
      "$ErrorActionPreference = 'Stop';",
      "$path = [System.Environment]::GetEnvironmentVariable('EBB_TARGET_OBJECT');",
      "$acl = Get-Acl -LiteralPath $path;",
      "$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20');",
      "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::CreateFiles, [System.Security.AccessControl.AccessControlType]::Allow);",
      "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl;",
    ].join(" "), { EBB_TARGET_OBJECT: fixtureHome });
  });
  await assertStaleTicketRejected("config-acl-change", ({ fixtureConfig }) => {
    runPowerShell([
      "$ErrorActionPreference = 'Stop';",
      "$path = [System.Environment]::GetEnvironmentVariable('EBB_TARGET_OBJECT');",
      "$acl = Get-Acl -LiteralPath $path;",
      "$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-20');",
      "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::WriteData, [System.Security.AccessControl.AccessControlType]::Allow);",
      "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl;",
    ].join(" "), { EBB_TARGET_OBJECT: fixtureConfig });
  });
  const pinnedFixture = prepareFixture("pinned-home");
  const pinned = startHolder(pinnedFixture, identityVector(pinnedFixture.fixtureProfile));
  await waitLine(pinned.child, "TARGETS_HELD\n");
  assert.throws(() => renameSync(pinnedFixture.fixtureHome, `${pinnedFixture.fixtureHome}.old`),
    "held home-directory handle should block rename/swap");
  pinned.child.stdin.write("CHECK\n");
  await waitLine(pinned.child, "TARGETS_STABLE\n");
  const [pinnedExitCode] = await new Promise((resolveClose) => pinned.child.once("close", (code) => resolveClose([code])));
  activeChild = undefined;
  assert.equal(pinnedExitCode, 0, pinned.getStderr());

  const deleteFixture = prepareFixture("pinned-config-delete");
  const deleting = startHolder(deleteFixture, identityVector(deleteFixture.fixtureProfile));
  await waitLine(deleting.child, "TARGETS_HELD\n");
  let configDeletedWhileHeld = false;
  try {
    unlinkSync(deleteFixture.fixtureConfig);
    configDeletedWhileHeld = true;
  } catch (error) {
    assert.ok(["EPERM", "EACCES", "EBUSY"].includes(error?.code),
      `unexpected config deletion failure while native target handle is held: ${String(error)}`);
  }
  deleting.child.stdin.write("CHECK\n");
  await waitLine(deleting.child, configDeletedWhileHeld ? "UNKNOWN\tTEST_TARGET_RECHECK_FAILED\n" : "TARGETS_STABLE\n");
  const [deleteExitCode] = await new Promise((resolveClose) => deleting.child.once("close", (code) => resolveClose([code])));
  activeChild = undefined;
  assert.equal(deleteExitCode, configDeletedWhileHeld ? 5 : 0, deleting.getStderr());

  console.log(`WINDOWS_RUN_SUPERVISOR_TARGET_ACCEPTANCE_PASS wrong_home_id=1 wrong_config_id=1 home_swap=1 home_junction=1 config_delete=2 config_replace=1 config_hardlink=1 home_acl_change=1 config_acl_change=1 held_home_rename_blocked=1 held_config_delete_while_held=${Number(configDeletedWhileHeld)} held_config_recheck=${configDeletedWhileHeld ? "mismatch-rejected" : "stable"}`);
} finally {
  if (activeChild && activeChild.exitCode === null) {
    activeChild.stdin.destroy();
    activeChild.kill();
    await new Promise((resolveClose) => activeChild.once("close", resolveClose));
  }
  rmSync(sandbox, { recursive: true, force: true });
}
