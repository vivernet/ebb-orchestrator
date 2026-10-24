/* global process */

// Pure PolicyV1 loader/validator (plan-26 Task2). Read-only: never mutates,
// never accepts secrets, reads only explicitly validated JSON paths.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const STABLE_SEMVER_PATTERN = '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$';
const STABLE_SEMVER_RE = new RegExp(`^${STABLE_SEMVER_PATTERN}$`);

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function policyHashOf(config) {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export function validateConfig(config) {
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, blockers: [{ code: 'CONFIG_NOT_OBJECT', field: 'config', detail: 'policy config must be a JSON object' }] };
  }
  if (config.schemaVersion !== SCHEMA_VERSION) fail('CONFIG_SCHEMA_VERSION', 'schemaVersion', `expected ${SCHEMA_VERSION}`);
  if (config.policyName !== 'PolicyV1') fail('CONFIG_POLICY_NAME', 'policyName', 'expected PolicyV1');
  if (!['pending', 'bound'].includes(config.bindingStatus)) fail('CONFIG_BINDING_STATUS', 'bindingStatus', 'expected pending|bound');

  const repository = config.repository;
  if (!repository || typeof repository !== 'object') {
    fail('CONFIG_REPOSITORY', 'repository', 'repository object required');
  } else {
    if (!Number.isInteger(repository.id) || repository.id <= 0) fail('CONFIG_REPOSITORY_ID', 'repository.id', 'positive integer required');
    if (typeof repository.owner !== 'string' || repository.owner.length === 0) fail('CONFIG_REPOSITORY_OWNER', 'repository.owner', 'non-empty string required');
    if (typeof repository.name !== 'string' || repository.name.length === 0) fail('CONFIG_REPOSITORY_NAME', 'repository.name', 'non-empty string required');
    if (typeof repository.remote !== 'string' || !repository.remote.startsWith('https://github.com/')) fail('CONFIG_REPOSITORY_REMOTE', 'repository.remote', 'github https remote required');
    if (repository.defaultBranch !== 'develop') fail('CONFIG_DEFAULT_BRANCH', 'repository.defaultBranch', 'expected develop');
    if (repository.releaseBranch !== 'refs/heads/master') fail('CONFIG_RELEASE_BRANCH', 'repository.releaseBranch', 'expected refs/heads/master');
  }

  const encoding = config.versionEncoding;
  if (!encoding || typeof encoding !== 'object') {
    fail('CONFIG_VERSION_ENCODING', 'versionEncoding', 'versionEncoding object required');
  } else {
    if (encoding.stableOnly !== true) fail('CONFIG_VERSION_ENCODING_STABLE', 'versionEncoding.stableOnly', 'expected true');
    if (encoding.allowPrerelease !== false || encoding.allowBuildMetadata !== false) {
      fail('CONFIG_VERSION_ENCODING_SUFFIX', 'versionEncoding', 'prerelease/build metadata must be disabled');
    }
    if (typeof encoding.pattern !== 'string') {
      fail('CONFIG_VERSION_ENCODING_PATTERN', 'versionEncoding.pattern', 'regex pattern required');
    } else {
      const patternRe = new RegExp(`^${encoding.pattern}$`);
      if (!patternRe.test('1.2.3') || patternRe.test('1.2.3-beta.1')) {
        fail('CONFIG_VERSION_ENCODING_PATTERN', 'versionEncoding.pattern', 'pattern must accept stable MAJOR.MINOR.PATCH only');
      }
    }
  }

  const platforms = config.gates?.requiredPlatforms;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    fail('CONFIG_GATES_PLATFORMS', 'gates.requiredPlatforms', 'non-empty array required');
  } else {
    for (const platform of platforms) {
      if (!platform || typeof platform !== 'object' || typeof platform.id !== 'string' || platform.id.length === 0) {
        fail('CONFIG_GATE_PLATFORM_ID', 'gates.requiredPlatforms[]', 'platform id required');
        continue;
      }
      const field = `gates.requiredPlatforms.${platform.id}`;
      if (!['configured', 'blocked', 'pending'].includes(platform.status)) fail('CONFIG_GATE_PLATFORM_STATUS', `${field}.status`, 'expected configured|blocked|pending');
      if (!Array.isArray(platform.requiredChecks) || platform.requiredChecks.length === 0) fail('CONFIG_GATE_PLATFORM_CHECKS', `${field}.requiredChecks`, 'non-empty checks required');
      if (platform.status !== 'configured') {
        if (typeof platform.blocker !== 'string' || platform.blocker.length === 0) fail('CONFIG_GATE_PLATFORM_BLOCKER', `${field}.blocker`, 'required for blocked/pending platform');
        if (typeof platform.producerTask !== 'string' || platform.producerTask.length === 0) fail('CONFIG_GATE_PLATFORM_PRODUCER', `${field}.producerTask`, 'required for blocked/pending platform');
      }
    }
  }

  const trusted = config.trustedBindings;
  const expectedPendingFields = [];
  if (!trusted || typeof trusted !== 'object') {
    fail('CONFIG_TRUSTED_BINDINGS', 'trustedBindings', 'trustedBindings object required');
  } else {
    const workflows = trusted.workflows ?? {};
    for (const name of ['release-validation.yml', 'release-operations.yml']) {
      const binding = workflows[name];
      const field = `trustedBindings.workflows.${name}.fullSha`;
      expectedPendingFields.push(field);
      if (!binding || typeof binding !== 'object') {
        fail('CONFIG_TRUSTED_BINDING', `trustedBindings.workflows.${name}`, 'binding object required');
        continue;
      }
      if (config.bindingStatus === 'pending') {
        if (binding.fullSha !== null) fail('CONFIG_TRUSTED_BINDING_PLACEHOLDER', field, 'pending binding must use structured null, not a placeholder SHA');
      } else if (typeof binding.fullSha !== 'string' || !FULL_SHA_PATTERN.test(binding.fullSha)) {
        fail('CONFIG_TRUSTED_BINDING_FULL_SHA', field, 'bound binding requires full 40-hex commit SHA');
      }
    }
    const bundle = trusted.scriptBundle;
    expectedPendingFields.push('trustedBindings.scriptBundle.fullSha');
    if (!bundle || typeof bundle !== 'object') {
      fail('CONFIG_TRUSTED_BINDING', 'trustedBindings.scriptBundle', 'script bundle binding required');
    } else if (config.bindingStatus === 'pending') {
      if (bundle.fullSha !== null) fail('CONFIG_TRUSTED_BINDING_PLACEHOLDER', 'trustedBindings.scriptBundle.fullSha', 'pending binding must use structured null, not a placeholder SHA');
    } else if (typeof bundle.fullSha !== 'string' || !FULL_SHA_PATTERN.test(bundle.fullSha)) {
      fail('CONFIG_TRUSTED_BINDING_FULL_SHA', 'trustedBindings.scriptBundle.fullSha', 'bound binding requires full 40-hex commit SHA');
    }
  }

  const blockedPlatformFields = Array.isArray(platforms)
    ? platforms.filter((platform) => platform && platform.status && platform.status !== 'configured').map((platform) => `gates.requiredPlatforms.${platform.id}.status`)
    : [];

  const pending = config.pendingBindings;
  if (!Array.isArray(pending)) {
    fail('CONFIG_PENDING_BINDINGS', 'pendingBindings', 'array required');
  } else {
    const seen = new Set();
    for (const entry of pending) {
      if (!entry || typeof entry !== 'object' || typeof entry.field !== 'string' || entry.field.length === 0) {
        fail('CONFIG_PENDING_BINDING_FORM', 'pendingBindings[]', 'entry requires field/producerTask/blocker');
        continue;
      }
      if (typeof entry.producerTask !== 'string' || entry.producerTask.length === 0) fail('CONFIG_PENDING_BINDING_FORM', `pendingBindings.${entry.field}.producerTask`, 'required');
      if (typeof entry.blocker !== 'string' || entry.blocker.length === 0) fail('CONFIG_PENDING_BINDING_FORM', `pendingBindings.${entry.field}.blocker`, 'required');
      seen.add(entry.field);
    }
    if (config.bindingStatus === 'pending') {
      for (const field of expectedPendingFields) {
        if (!seen.has(field)) fail('CONFIG_PENDING_BINDING_UNRESOLVED', 'pendingBindings', `missing pending entry for ${field}`);
      }
      for (const field of blockedPlatformFields) {
        if (!seen.has(field)) fail('CONFIG_PENDING_BINDING_UNRESOLVED', 'pendingBindings', `missing pending entry for ${field}`);
      }
      const known = new Set([...expectedPendingFields, ...blockedPlatformFields]);
      for (const entry of pending) {
        if (!known.has(entry.field)) fail('CONFIG_PENDING_BINDING_UNKNOWN', 'pendingBindings', `unknown pending field ${entry.field}`);
      }
    } else if (pending.length > 0) {
      fail('CONFIG_PENDING_BINDINGS_ON_BOUND', 'pendingBindings', 'bound config must have empty pendingBindings');
    }
  }

  if (config.mutationPolicy?.requiresBindingStatus !== 'bound') fail('CONFIG_MUTATION_POLICY', 'mutationPolicy.requiresBindingStatus', 'expected bound');

  return { valid: blockers.length === 0, blockers };
}

export function collectGateBlockers(config, coveredIds) {
  const blockers = [];
  for (const platform of config.gates?.requiredPlatforms ?? []) {
    const field = `gates.requiredPlatforms.${platform.id}`;
    if (platform.status === 'configured') {
      if (!coveredIds.includes(platform.id)) {
        blockers.push({ code: 'GATE_PLATFORM_COVERAGE', field, detail: `required platform ${platform.id} (${platform.platform}) missing from evidence` });
      }
    } else {
      blockers.push({ code: 'GATE_PLATFORM_BLOCKED', field: `${field}.status`, detail: `${platform.blocker} (producer ${platform.producerTask})` });
    }
  }
  return blockers;
}

function makeReport(status, exitCode, blockers, notes, configValid, inputValid, intent) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'policy:check',
    mode: 'read-only',
    status,
    exitCode,
    configValid,
    inputValid,
    intent,
    blockers,
    notes,
  };
}

export function validateInput(rawInput, config) {
  const blockers = [];
  const notes = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  const configResult = validateConfig(config);
  if (!configResult.valid) {
    return makeReport('CONFIG_ERROR', 2, configResult.blockers, [], false, false, 'check');
  }

  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    fail('INPUT_NOT_OBJECT', 'input', 'event file must contain a JSON object');
    return makeReport('BLOCKED', 1, blockers, notes, true, true, 'check');
  }
  if (rawInput.schemaVersion !== SCHEMA_VERSION) fail('INPUT_SCHEMA_VERSION', 'schemaVersion', `expected ${SCHEMA_VERSION}`);

  const repository = rawInput.repository;
  if (!repository || typeof repository !== 'object') fail('INPUT_REPOSITORY_MISSING', 'repository', 'repository object required');

  const event = rawInput.event;
  if (!event || typeof event !== 'object') {
    fail('INPUT_EVENT_MISSING', 'event', 'event object required');
  } else {
    if (!['push', 'pull_request'].includes(event.type)) fail('INPUT_EVENT_TYPE', 'event.type', `unsupported event type ${event.type}`);
    if (typeof event.ref !== 'string' || !event.ref.startsWith('refs/')) fail('INPUT_EVENT_REF', 'event.ref', 'must be a refs/ ref');
    if (event.type === 'push' && !event.ref.startsWith('refs/heads/')) fail('INPUT_EVENT_REF', 'event.ref', 'push events must reference refs/heads/<branch>');
    if (event.type === 'pull_request' && typeof event.baseRef !== 'string') fail('INPUT_EVENT_BASE_REF', 'event.baseRef', 'required for pull_request events');
  }

  const masterPush = Boolean(event && event.type === 'push' && event.ref === 'refs/heads/master');
  if (masterPush) {
    const masterState = rawInput.masterState;
    if (!masterState || typeof masterState !== 'object') {
      fail('INPUT_MASTER_STATE_MISSING', 'masterState', 'required for master push events');
    } else {
      if (typeof masterState.exists !== 'boolean') fail('INPUT_MASTER_STATE_EXISTS', 'masterState.exists', 'boolean required');
      if (!Number.isInteger(masterState.releasesCount) || masterState.releasesCount < 0) fail('INPUT_MASTER_STATE_RELEASES', 'masterState.releasesCount', 'non-negative integer required');
      if (masterState.exists === true && (typeof masterState.sha !== 'string' || !FULL_SHA_PATTERN.test(masterState.sha))) {
        fail('INPUT_MASTER_STATE_SHA', 'masterState.sha', 'full commit SHA required when master exists');
      }
    }
    if (!event.commit || typeof event.commit !== 'object') fail('INPUT_EVENT_COMMIT_MISSING', 'event.commit', 'required for master push events');
  }

  const configuredRepository = config.repository;
  if (repository) {
    if (repository.id !== configuredRepository.id) fail('REPO_IDENTITY_MISMATCH', 'repository.id', `expected ${configuredRepository.id}, got ${repository.id}`);
    if (repository.owner !== configuredRepository.owner) fail('REPO_IDENTITY_MISMATCH', 'repository.owner', `expected ${configuredRepository.owner}, got ${repository.owner}`);
    if (repository.name !== configuredRepository.name) fail('REPO_IDENTITY_MISMATCH', 'repository.name', `expected ${configuredRepository.name}, got ${repository.name}`);
    if (repository.remote !== configuredRepository.remote) fail('REPO_IDENTITY_MISMATCH', 'repository.remote', `expected ${configuredRepository.remote}, got ${repository.remote}`);
  }

  if (rawInput.version !== undefined && rawInput.version !== null) {
    if (typeof rawInput.version !== 'string' || !STABLE_SEMVER_RE.test(rawInput.version)) {
      fail('SEMVER_ENCODING_VIOLATION', 'version', `"${rawInput.version}" violates stable MAJOR.MINOR.PATCH-only encoding`);
    }
  }

  if (event && event.type === 'pull_request' && event.baseRef === 'refs/heads/master') {
    fail('PR_BASE_MASTER_FORBIDDEN', 'event.baseRef', 'ordinary pull requests must target refs/heads/develop');
  }

  const intent = typeof rawInput.intent === 'string' && rawInput.intent.length > 0 ? rawInput.intent : 'check';
  const isMutation = intent !== 'check';

  if (masterPush) {
    const masterState = rawInput.masterState;
    if (masterState && masterState.exists === true && masterState.releasesCount === 0) {
      fail('BLOCKED_LEGACY_MASTER', 'masterState', 'master exists with zero releases: legacy master pre-transition must be removed by the approved transition, not treated as a release');
    }
    const commit = event.commit;
    const parents = commit && Array.isArray(commit.parents) ? commit.parents : [];
    if (parents.length >= 2) {
      fail('MERGE_RELEASE_COMMIT_FORBIDDEN', 'event.commit.parents', 'release commits must be root or single-parent; merge/dummy commits forbidden');
    } else if (parents.length === 0) {
      if (masterState && masterState.exists === true) {
        fail('ROOT_LATER_PARENT_MISMATCH', 'event.commit.parents', 'root commit detected while master already exists; later release must pin previous master as its single parent');
      }
    } else {
      if (!masterState || masterState.exists !== true) {
        fail('ROOT_LATER_PARENT_MISMATCH', 'event.commit.parents', 'single-parent release commit without existing master; root must come first');
      } else if (parents[0] !== masterState.sha) {
        fail('ROOT_LATER_PARENT_MISMATCH', 'event.commit.parents', 'parent does not equal pinned previous master');
      }
    }
    const provenance = commit && commit.provenance;
    if (!provenance || typeof provenance !== 'object' || typeof provenance.sourceSha !== 'string' || typeof provenance.sourceTree !== 'string') {
      fail('MISSING_PROVENANCE', 'event.commit.provenance', 'release commit must carry provenance (sourceSha/sourceTree)');
    } else if (provenance.sourceTree !== commit.tree) {
      fail('TREE_MISMATCH', 'event.commit.tree', 'candidate tree must equal pinned source tree (dummy commit shape)');
    }
    if (masterState && masterState.exists === false && masterState.releasesCount === 0) {
      notes.push('ABSENT_MASTER_ZERO_RELEASES_ACCEPTED: absent master with zero releases accepted explicitly; first root candidate allowed');
    }
    const covered = new Set((rawInput.evidence?.platforms ?? []).map((platform) => platform.id));
    for (const blocker of collectGateBlockers(config, [...covered])) blockers.push(blocker);
  }

  if (isMutation) {
    if (config.bindingStatus !== 'bound') {
      fail('MUTATION_NOT_ALLOWED', 'bindingStatus', `mutation intent "${intent}" requires bindingStatus bound; config is ${config.bindingStatus}`);
    }
    for (const entry of config.pendingBindings ?? []) {
      fail('PENDING_TRUSTED_BINDING', entry.field, `${entry.producerTask}: ${entry.blocker}`);
    }
    const covered = new Set((rawInput.evidence?.platforms ?? []).map((platform) => platform.id));
    for (const blocker of collectGateBlockers(config, [...covered])) blockers.push(blocker);
  } else if (masterPush) {
    for (const entry of config.pendingBindings ?? []) {
      fail('PENDING_TRUSTED_BINDING', entry.field, `${entry.producerTask}: ${entry.blocker}`);
    }
  }

  const status = blockers.length === 0 ? 'PASS' : 'BLOCKED';
  return makeReport(status, blockers.length === 0 ? 0 : 1, blockers, notes, true, true, intent);
}

export function runPolicyCheck({ config, input }) {
  const result = validateInput(input, config);
  return {
    ...result,
    policyHash: policyHashOf(config),
    bindingStatus: config && typeof config === 'object' ? config.bindingStatus : null,
  };
}

export function main(argv) {
  const emit = (report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  };
  const args = [...argv];
  const subcommand = args.shift();
  if (subcommand !== 'check') {
    return emit(makeReport('CONFIG_ERROR', 2, [{ code: 'CLI_USAGE', field: 'argv', detail: 'usage: node scripts/release/policy.mjs check --event-file <validated-path>' }], [], false, false, 'check'));
  }
  let eventFile = null;
  let configPath = null;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--event-file') {
      eventFile = args.shift();
    } else if (arg === '--config') {
      configPath = args.shift();
    } else {
      return emit(makeReport('CONFIG_ERROR', 2, [{ code: 'CLI_UNKNOWN_ARG', field: 'argv', detail: `unknown argument ${arg}` }], [], false, false, 'check'));
    }
  }
  if (!eventFile) {
    return emit(makeReport('CONFIG_ERROR', 2, [{ code: 'CLI_MISSING_EVENT_FILE', field: 'argv', detail: '--event-file is required' }], [], false, false, 'check'));
  }
  const resolvedConfigPath = configPath ?? join(process.cwd(), '.ebb', 'release-policy.json');
  let config;
  let input;
  try {
    config = JSON.parse(readFileSync(resolvedConfigPath, 'utf8'));
  } catch (error) {
    return emit(makeReport('CONFIG_ERROR', 2, [{ code: 'CONFIG_READ_FAILED', field: 'configPath', detail: String(error.message) }], [], false, false, 'check'));
  }
  try {
    input = JSON.parse(readFileSync(eventFile, 'utf8'));
  } catch (error) {
    return emit(makeReport('CONFIG_ERROR', 2, [{ code: 'EVENT_FILE_READ_FAILED', field: 'eventFile', detail: String(error.message) }], [], false, false, 'check'));
  }
  return emit(runPolicyCheck({ config, input }));
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile === thisFile) {
  process.exitCode = main(process.argv.slice(2));
}
