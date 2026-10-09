#!/usr/bin/env bash
# Только prerequisite временного trusted push runner; production policy не изменяется.
# Ubuntu рекомендует per-application userns rule:
# https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted &&
   "${GITHUB_EVENT_NAME:-}" == push && "$(uname -s)" == Linux && "$(id -u)" != 0 ]] ||
  fail HERMES_NAMESPACE_SETUP_REQUIRES_EPHEMERAL_HOSTED_PUSH_RUNNER
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] ||
  fail HERMES_NAMESPACE_SETUP_RUN_ID_INVALID
runner_temp="$(realpath -e -- "${RUNNER_TEMP:?}")"
[[ "$runner_temp" =~ ^/[a-zA-Z0-9_./-]+$ && "$runner_temp" != / ]] ||
  fail HERMES_NAMESPACE_SETUP_TEMP_PATH_INVALID
state_dir="${runner_temp}/ebb-hermes-userns-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

# CI допускает только одноразовый hosted VM; profiles сохраняются до его disposal.
[[ ! -e /.dockerenv && ! -e /run/.containerenv && -z "${container:-}" &&
   "${ImageOS:-}" == ubuntu24 && "${ImageVersion:-}" =~ ^[0-9.]+$ ]] ||
  fail HERMES_NAMESPACE_SETUP_RUNNER_DISPOSAL_UNPROVEN
[[ "$(systemd-detect-virt --container 2>/dev/null || true)" == none ]] ||
  fail HERMES_NAMESPACE_SETUP_CONTAINER_UNSUPPORTED

policy_operation() {
  python3 - "$1" "$state_dir" "$launcher" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" <<'CI_POLICY_PYTHON'
# BEGIN CI_POLICY_PYTHON
import hashlib
import json
import os
import posixpath
import re
import stat
import subprocess
import sys

class Refusal(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Refusal(code)

def command(args, policy=None):
    result = subprocess.run(args, input=policy, capture_output=True, timeout=120, check=False)
    require(result.returncode == 0, 'HERMES_NAMESPACE_SETUP_AUTHORITY_COMMAND_FAILED')
    require(len(result.stdout) <= 8 * 1024 * 1024, 'HERMES_NAMESPACE_SETUP_AUTHORITY_OUTPUT_INVALID')
    return result.stdout

def check_attachments(profiles, targets):
    for name, profile in profiles.items():
        require(name not in targets, 'HERMES_NAMESPACE_SETUP_PROFILE_NAME_CONFLICT')
        attachment = profile['attach']
        require(attachment != '<unknown>', 'HERMES_NAMESPACE_SETUP_POLICY_ATTACHMENT_UNKNOWN')
        # Kernel exposes the profile name when there is no exec attachment.
        if attachment == name.rsplit('//', 1)[-1] and not attachment.startswith('/'):
            continue
        require(attachment.startswith('/'), 'HERMES_NAMESPACE_SETUP_POLICY_ATTACHMENT_UNKNOWN')
        # AARE is not interpreted as a shell glob. Only a literal prefix proves
        # disjointness; brace/class/escape/xattr ambiguity near a target refuses.
        prefix = re.match(r'/[a-zA-Z0-9_./-]*', attachment).group(0)
        for target in targets.values():
            require(not target.startswith(prefix), 'HERMES_NAMESPACE_SETUP_POLICY_ATTACHMENT_CONFLICT')

def check_change(before, after, name, target, binary_digest):
    require(after['namespace'] == before['namespace'] and
            after['revision'] == before['revision'] + 1,
            'HERMES_NAMESPACE_SETUP_POLICY_REVISION_RACE')
    expected = dict(before['profiles'])
    require(name not in expected and name in after['profiles'], 'HERMES_NAMESPACE_SETUP_PROFILE_READBACK_INVALID')
    profile = after['profiles'][name]
    require(profile['attach'] == target and profile.get('raw_sha256') == binary_digest and re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', profile['hash']),
            'HERMES_NAMESPACE_SETUP_PROFILE_READBACK_INVALID')
    expected[name] = profile
    require(after['profiles'] == expected, 'HERMES_NAMESPACE_SETUP_UNEXPECTED_POLICY_CHANGE')

SNAPSHOT = r'''
import json, os, re, stat
base = '/sys/kernel/security/apparmor'
def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try: value = os.read(fd, 8192)
    finally: os.close(fd)
    if not value or len(value) == 8192: raise ValueError('incomplete')
    text = value.decode('utf-8').removesuffix('\n')
    if '\n' in text or '\x00' in text: raise ValueError('invalid')
    return text
def identity():
    if read(base+'/.ns_level') != '0' or read(base+'/.ns_name') != 'root': raise ValueError('namespace')
    if read(base+'/.ns_stacked') != 'no' or read(base+'/.stacked') != 'no': raise ValueError('stacked')
    value = read(base+'/revision')
    if not re.fullmatch('[0-9]+', value): raise ValueError('revision')
    return int(value)
before = identity()
profiles = {}
def walk(directory, parent=''):
    entries = list(os.scandir(directory))
    if len(entries) > 4096: raise ValueError('bound')
    for entry in entries:
        if not entry.is_dir(follow_symlinks=False): raise ValueError('type')
        local_name, attach, digest = [read(entry.path+'/'+field) for field in ('name', 'attach', 'sha256')]
        name = parent+local_name
        if not name or name in profiles or not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', digest): raise ValueError('profile')
        profiles[name] = {'attach': attach, 'hash': digest}
        # raw_sha256 is a kernel-created symlink to the hash of the entire
        # serialized load, unlike sha256 (version + unpacked profile payload).
        raw_hash = entry.path+'/raw_sha256'
        if os.path.exists(raw_hash):
            resolved = os.path.realpath(raw_hash)
            if not re.fullmatch(re.escape(base)+r'/policy/raw_data/[^/]+/sha256', resolved): raise ValueError('raw hash path')
            raw_digest = read(resolved)
            if not re.fullmatch('[a-f0-9]{64}', raw_digest): raise ValueError('raw hash')
            profiles[name]['raw_sha256'] = raw_digest
        child = entry.path+'/profiles'
        if os.path.exists(child): walk(child, name+'//')
walk(base+'/policy/profiles')
after = identity()
if before != after: raise ValueError('race')
print(json.dumps({'namespace':'root', 'revision':after, 'profiles':profiles}, sort_keys=True))
'''

def snapshot():
    # Privileged read only kernel-policy query; raw names never leave private state.
    data = command(['sudo', '-n', 'python3', '-I', '-S', '-c', SNAPSHOT])
    return json.loads(data)

def profile_targets(state, launcher, run_id, attempt):
    require(re.fullmatch('[0-9]+', run_id) and re.fullmatch('[0-9]+', attempt), 'HERMES_NAMESPACE_SETUP_RUN_ID_INVALID')
    targets = {'ebb-hermes-launcher-'+run_id+'-'+attempt: launcher,
               'ebb-hermes-probe-'+run_id+'-'+attempt: posixpath.join(state, 'probe')}
    for target in targets.values():
        require(re.fullmatch('/[a-zA-Z0-9_./-]+', target) and posixpath.normpath(target) == target,
                'HERMES_NAMESPACE_SETUP_PROFILE_PATH_INVALID')
    return targets

def policy_bytes(name, target):
    require(re.fullmatch('ebb-hermes-(launcher|probe)-[0-9]+-[0-9]+', name) and
            re.fullmatch('/[a-zA-Z0-9_./-]+', target) and posixpath.normpath(target) == target,
            'HERMES_NAMESPACE_SETUP_PROFILE_CONTENT_INVALID')
    # Единственный разрешённый source, без runner-owned policy file.
    return ('abi <abi/4.0>,\nprofile '+name+' "'+target+'" flags=(default_allow) {\n  userns,\n}\n').encode('ascii')

def compile_policy(policy):
    require(isinstance(policy, bytes) and 0 < len(policy) <= 4096,
            'HERMES_NAMESPACE_SETUP_PROFILE_CONTENT_INVALID')
    binary = command(['sudo', '-n', 'apparmor_parser', '--skip-kernel-load', '--skip-cache', '--stdout'], policy)
    require(binary, 'HERMES_NAMESPACE_SETUP_PROFILE_PREFLIGHT_INVALID')
    return hashlib.sha256(binary).hexdigest()

def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= limit,
                'HERMES_NAMESPACE_SETUP_HELPER_IDENTITY_INVALID')
        data = bytearray()
        while len(data) <= limit:
            block = os.read(fd, min(65536, limit+1-len(data)))
            if not block: break
            data.extend(block)
        after, linked = os.fstat(fd), os.stat(path, follow_symlinks=False)
        require(len(data) == before.st_size and stat.S_ISREG(linked.st_mode) and
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                (before.st_dev, before.st_ino) == (linked.st_dev, linked.st_ino),
                'HERMES_NAMESPACE_SETUP_HELPER_IDENTITY_INVALID')
        return bytes(data), {'dev': before.st_dev, 'ino': before.st_ino,
                             'sha256': hashlib.sha256(data).hexdigest()}
    finally: os.close(fd)

def helper_identity(launcher):
    require(os.path.realpath(launcher) == launcher, 'HERMES_NAMESPACE_SETUP_HELPER_IDENTITY_INVALID')
    _, identity = read_regular(launcher, 16 * 1024 * 1024)
    anchor_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(launcher))),
                               'platform', 'process', 'native-helper-integrity-anchor.js')
    require(os.path.realpath(anchor_path) == anchor_path, 'HERMES_NAMESPACE_SETUP_HELPER_ANCHOR_INVALID')
    anchor, _ = read_regular(anchor_path, 8192)
    match = re.fullmatch(rb'export const NATIVE_HELPER_INTEGRITY_ANCHOR = Object.freeze\((\{[^\n]+\})\);\n', anchor)
    require(match is not None, 'HERMES_NAMESPACE_SETUP_HELPER_ANCHOR_INVALID')
    expected = json.loads(match.group(1))
    require(isinstance(expected, dict) and expected.get('linuxHermesLauncher') == identity['sha256'],
            'HERMES_NAMESPACE_SETUP_HELPER_CONTENT_MISMATCH')
    return identity

def prepare(state, launcher, run_id, attempt):
    targets = profile_targets(state, launcher, run_id, attempt)
    helper = helper_identity(launcher)
    initial = snapshot()
    check_attachments(initial['profiles'], targets)
    previous, owned = initial, {}
    for name, target in targets.items():
        policy = policy_bytes(name, target)
        binary_digest = compile_policy(policy)
        require(snapshot() == previous, 'HERMES_NAMESPACE_SETUP_POLICY_REVISION_RACE')
        open(os.path.join(state, name+'.attempted'), 'x').close()
        # Тот же immutable bytes object, проверенный parser; pathname не открывается.
        command(['sudo', '-n', 'apparmor_parser', '--add', '--skip-cache'], policy)
        current = snapshot()
        check_change(previous, current, name, target, binary_digest)
        open(os.path.join(state, name+'.loaded'), 'x').close()
        open(os.path.join(state, name+'.owned'), 'x').close()
        owned[name] = {'source_sha256': hashlib.sha256(policy).hexdigest(), 'binary_sha256': binary_digest}
        previous = current
    require(snapshot() == previous and helper_identity(launcher) == helper, 'HERMES_NAMESPACE_SETUP_POLICY_REVISION_RACE')
    with open(os.path.join(state, 'policy-evidence.json'), 'x') as output:
        json.dump({'schema': 1, 'before': initial, 'after': previous, 'owned': owned, 'helper': helper}, output, sort_keys=True)

def verify_evidence(evidence, current, targets):
    require(isinstance(evidence, dict) and set(evidence) == {'schema', 'before', 'after', 'owned', 'helper'} and
            evidence['schema'] == 1 and isinstance(evidence['owned'], dict) and
            set(evidence['owned']) == set(targets), 'HERMES_NAMESPACE_SETUP_POLICY_EVIDENCE_INVALID')
    previous = evidence['before']
    require(isinstance(previous, dict) and set(previous) == {'namespace', 'revision', 'profiles'} and
            previous['namespace'] == 'root' and type(previous['revision']) is int and previous['revision'] >= 0 and
            isinstance(previous['profiles'], dict), 'HERMES_NAMESPACE_SETUP_POLICY_EVIDENCE_INVALID')
    check_attachments(previous['profiles'], targets)
    after = evidence['after']
    require(isinstance(after, dict) and set(after) == {'namespace', 'revision', 'profiles'} and
            isinstance(after['profiles'], dict), 'HERMES_NAMESPACE_SETUP_POLICY_EVIDENCE_INVALID')
    for name, target in targets.items():
        owned = evidence['owned'][name]
        require(isinstance(owned, dict) and set(owned) == {'source_sha256', 'binary_sha256'} and
                owned['source_sha256'] == hashlib.sha256(policy_bytes(name, target)).hexdigest() and
                re.fullmatch('[a-f0-9]{64}', owned['binary_sha256']) and name in after['profiles'] and
                owned['binary_sha256'] == compile_policy(policy_bytes(name, target)),
                'HERMES_NAMESPACE_SETUP_POLICY_EVIDENCE_INVALID')
        next_snapshot = {'namespace': 'root', 'revision': previous['revision']+1,
                         'profiles': {**previous['profiles'], name: after['profiles'][name]}}
        check_change(previous, next_snapshot, name, target, owned['binary_sha256'])
        previous = next_snapshot
    require(previous == after and current == after, 'HERMES_NAMESPACE_SETUP_POLICY_EVIDENCE_MISMATCH')

def verify(state, launcher, run_id, attempt):
    evidence_fd = os.open(os.path.join(state, 'policy-evidence.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(stat.S_ISREG(os.fstat(evidence_fd).st_mode), 'HERMES_NAMESPACE_SETUP_POLICY_EVIDENCE_INVALID')
        data = os.read(evidence_fd, 8 * 1024 * 1024 + 1)
        require(0 < len(data) <= 8 * 1024 * 1024, 'HERMES_NAMESPACE_SETUP_POLICY_EVIDENCE_INVALID')
        evidence = json.loads(data)
    finally: os.close(evidence_fd)
    require(isinstance(evidence, dict) and evidence.get('helper') == helper_identity(launcher),
            'HERMES_NAMESPACE_SETUP_HELPER_IDENTITY_INVALID')
    verify_evidence(evidence, snapshot(), profile_targets(state, launcher, run_id, attempt))

if __name__ == '__main__':
    try:
        require(sys.argv[1] in ('prepare', 'verify'), 'HERMES_NAMESPACE_SETUP_POLICY_MODE_INVALID')
        (prepare if sys.argv[1] == 'prepare' else verify)(*sys.argv[2:])
    except Refusal as error: print(str(error), file=sys.stderr); sys.exit(1)
    except Exception: print('HERMES_NAMESPACE_SETUP_AUTHORITY_UNAVAILABLE', file=sys.stderr); sys.exit(1)
# END CI_POLICY_PYTHON
CI_POLICY_PYTHON
}

prepare_application_profiles() { policy_operation prepare; }
verify_policy_evidence() { policy_operation verify; }

cleanup() {
  [[ ! -e "$state_dir" ]] && fail HERMES_NAMESPACE_SETUP_TEARDOWN_STATE_MISSING
  [[ ! -L "$state_dir" && "$(realpath -e -- "$state_dir")" == "$state_dir" ]] ||
    fail HERMES_NAMESPACE_SETUP_STATE_PATH_INVALID
  [[ -f "${state_dir}/acceptance-completed" && ! -L "${state_dir}/acceptance-completed" ]] ||
    fail HERMES_NAMESPACE_SETUP_ACCEPTANCE_NOT_COMPLETED
  local units load_state unit
  if ! units="$(systemctl --user list-units --all --no-legend --plain 'ebb-orchestrator-run-*.service' 2>/dev/null)"; then
    fail HERMES_NAMESPACE_SETUP_OWNED_SCOPE_STATE_UNKNOWN
  fi
  [[ -z "$units" ]] || fail HERMES_NAMESPACE_SETUP_OWNED_SCOPE_NOT_REMOVED
  [[ -s "${state_dir}/probe-units" && ! -L "${state_dir}/probe-units" ]] ||
    fail HERMES_NAMESPACE_SETUP_PROBE_UNIT_STATE_UNKNOWN
  while IFS= read -r unit; do
    [[ "$unit" =~ ^ebb-hermes-userns-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-[0-9]+\.service$ ]] ||
      fail HERMES_NAMESPACE_SETUP_PROBE_UNIT_STATE_UNKNOWN
    if ! load_state="$(systemctl --user show "$unit" --property=LoadState --value 2>/dev/null)"; then
      fail HERMES_NAMESPACE_SETUP_PROBE_UNIT_STATE_UNKNOWN
    fi
    [[ "$load_state" == not-found ]] || fail HERMES_NAMESPACE_SETUP_PROBE_UNIT_NOT_REMOVED
  done < "${state_dir}/probe-units"
  for unit in launcher probe; do
    local name="ebb-hermes-${unit}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
    [[ -f "${state_dir}/${name}.loaded" && ! -L "${state_dir}/${name}.loaded" &&
       -f "${state_dir}/${name}.owned" && ! -L "${state_dir}/${name}.owned" &&
       -f "${state_dir}/${name}.attempted" && ! -L "${state_dir}/${name}.attempted" ]] ||
      fail HERMES_NAMESPACE_SETUP_PROFILE_OWNERSHIP_UNKNOWN
  done
  verify_policy_evidence
  [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" == 1 ]] ||
    fail HERMES_NAMESPACE_SETUP_GLOBAL_RESTRICTION_CHANGED
  # Kernel-wide exec races prohibit unload proof. Lease ends at runner disposal.
  printf 'HERMES_NATIVE_NAMESPACE_OWNED_SCOPE_TEARDOWN=VERIFIED\n'
  printf 'HERMES_NATIVE_NAMESPACE_PROFILES=RETAINED_UNTIL_RUNNER_DISPOSAL\n'
}

repository_root="$(realpath -e -- "${GITHUB_WORKSPACE:?}")"
launcher="${repository_root}/apps/server/dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher"

case "${1:-}" in
  cleanup) cleanup; exit 0 ;;
  acceptance-completed)
    [[ -d "$state_dir" && ! -L "$state_dir" ]] || fail HERMES_NAMESPACE_SETUP_STATE_PATH_INVALID
    ( set -o noclobber; : > "${state_dir}/acceptance-completed" ); exit 0 ;;
  setup) ;;
  *) fail HERMES_NAMESPACE_SETUP_MODE_INVALID ;;
esac

[[ "$(pwd -P)" == "$repository_root" && "$repository_root" != / && "$repository_root" =~ ^/[a-zA-Z0-9_./-]+$ ]] ||
  fail HERMES_NAMESPACE_SETUP_REPOSITORY_PATH_INVALID
[[ -f "$launcher" && -x "$launcher" && ! -L "$launcher" && "$(realpath -e -- "$launcher")" == "$launcher" ]] ||
  fail HERMES_NAMESPACE_SETUP_HELPER_PATH_INVALID
[[ ! -e "$state_dir" ]] || fail HERMES_NAMESPACE_SETUP_STATE_ALREADY_EXISTS
umask 077
mkdir -m 700 -- "$state_dir"
"${CXX:-c++}" -std=c++17 -O2 -Wall -Wextra -Wpedantic \
  "-DEBB_NAMESPACE_PROBE_PROFILE_NAME=\"ebb-hermes-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}\"" \
  scripts/linux-hermes-namespace-probe.cpp -o "${state_dir}/probe" -lapparmor
cp -- "${state_dir}/probe" "${state_dir}/negative-probe"

restriction() {
  local value
  value="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)"
  [[ "$value" == 0 || "$value" == 1 ]] || value=UNAVAILABLE
  printf '%s' "$value"
}
before_restriction="$(restriction)"
printf 'HERMES_NATIVE_NAMESPACE_APPARMOR_RESTRICTION=%s\n' "$before_restriction"

validate_probe_output() {
  local label='(UNCONFINED|EXPECTED_PROFILE|RESTRICTED_USERNS|OTHER|UNAVAILABLE)'
  local context_pattern="^HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=${label}:AFTER=${label}:NNP=(-1|0|1):SECCOMP=(-1|0|1|2)$"
  probe_context="${probe_output%%$'\n'*}"
  probe_result="${probe_output#*$'\n'}"
  [[ "$probe_output" == *$'\n'* && "$probe_context" =~ $context_pattern &&
     "$probe_result" =~ ^HERMES_NATIVE_NAMESPACE_PROBE:(PASS|HERMES_APPARMOR_PROFILE_TRANSITION_(UNAVAILABLE|LABEL_MISMATCH)|HERMES_PRIVATE_NAMESPACE_(UNSHARE|SETGROUPS_MAP|UID_MAP|GID_MAP|SETRESGID|SETRESUID|MOUNT_PROPAGATION)_UNAVAILABLE):ERRNO=[0-9]+$ ]] ||
    fail HERMES_NAMESPACE_SETUP_PROBE_OUTPUT_INVALID
}

run_probe() {
  local probe_args=() probe_path="${state_dir}/probe"
  [[ "$#" == 0 || ( "$#" == 1 && ( "$1" == --apply-exact-profile || "$1" == --negative-control ) ) ]] ||
    fail HERMES_NAMESPACE_SETUP_PROBE_MODE_INVALID
  if [[ "$#" == 1 && "$1" == --apply-exact-profile ]]; then probe_args=(--apply-exact-profile); fi
  if [[ "$#" == 1 && "$1" == --negative-control ]]; then probe_path="${state_dir}/negative-probe"; fi
  local unit="ebb-hermes-userns-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-$$.service"
  printf '%s\n' "$unit" >> "${state_dir}/probe-units"
  set +e
  systemd-run --user --quiet --wait --pipe --collect --unit="$unit" \
    --property=Type=exec --property=ExitType=cgroup --property=KillMode=control-group \
    --property=Delegate=no --property=ProtectControlGroups=yes --property=Restart=no \
    "$probe_path" "${probe_args[@]}" >"${state_dir}/probe-output" 2>&1
  probe_status=$?
  set -e
  probe_output="$(cat "${state_dir}/probe-output")"
  # Не выводить raw systemd/compiler/kernel diagnostics в refusal evidence.
  validate_probe_output
  printf '%s\n' "$probe_output"
  # --collect может уже удалить unit: stop/reset не являются removal proof.
  # Их отсутствие допустимо только после успешного show с точным not-found.
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  local load_state
  for attempt in {1..20}; do
    if load_state="$(systemctl --user show "$unit" --property=LoadState --value 2>/dev/null)"; then
      [[ "$load_state" == not-found ]] && return 0
    fi
    sleep 0.25
  done
  fail HERMES_NAMESPACE_SETUP_PROBE_UNIT_NOT_REMOVED
}

run_probe
if [[ "$probe_status" == 0 && "$probe_result" == HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0 ]]; then
  # Ограниченный prerequisite требует исходный refusal для отрицательного контроля.
  fail HERMES_NAMESPACE_SETUP_NEGATIVE_CONTROL_UNAVAILABLE
fi
[[ "$probe_status" == 70 && "$before_restriction" == 1 &&
   "$probe_result" =~ ^HERMES_NATIVE_NAMESPACE_PROBE:HERMES_PRIVATE_NAMESPACE_UNSHARE_UNAVAILABLE:ERRNO=(1|13)$ ]] ||
  fail HERMES_NAMESPACE_SETUP_UNSUPPORTED_REFUSAL
[[ "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]] ||
  fail HERMES_NAMESPACE_SETUP_APPARMOR_NOT_ACTIVE
command -v apparmor_parser >/dev/null || fail HERMES_NAMESPACE_SETUP_APPARMOR_PARSER_UNAVAILABLE
# Exact application attachments only; systemd executor/manager policy не изменяется.
prepare_application_profiles
[[ "$(restriction)" == "$before_restriction" ]] || fail HERMES_NAMESPACE_SETUP_GLOBAL_RESTRICTION_CHANGED
run_probe
[[ "$probe_status" == 0 && "$probe_result" == HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0 &&
   "$probe_context" == HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=EXPECTED_PROFILE:AFTER=EXPECTED_PROFILE:* ]] ||
  fail HERMES_NAMESPACE_SETUP_SCOPED_PROFILE_DID_NOT_RESOLVE_REFUSAL
run_probe --negative-control
[[ "$probe_status" == 70 &&
   "$probe_context" == HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=UNCONFINED:AFTER=UNCONFINED:* &&
   "$probe_result" =~ ^HERMES_NATIVE_NAMESPACE_PROBE:HERMES_PRIVATE_NAMESPACE_UNSHARE_UNAVAILABLE:ERRNO=(1|13)$ ]] ||
  fail HERMES_NAMESPACE_SETUP_NEGATIVE_CONTROL_UNEXPECTED
[[ "$(restriction)" == "$before_restriction" ]] || fail HERMES_NAMESPACE_SETUP_GLOBAL_RESTRICTION_CHANGED
verify_policy_evidence
printf 'HERMES_NATIVE_NAMESPACE_SCOPED_APPARMOR_PROFILE=VERIFIED\n'

# Profiles retained until one-shot hosted runner destruction.
