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
profile_file="${state_dir}/apparmor-profile"

cleanup() {
  [[ ! -e "$state_dir" ]] && return 0
  [[ ! -L "$state_dir" && "$(realpath -e -- "$state_dir")" == "$state_dir" &&
     "$(stat -c '%u:%a' -- "$state_dir")" == "$(id -u):700" ]] ||
    fail HERMES_NAMESPACE_SETUP_STATE_PATH_INVALID
  if [[ -e "${state_dir}/profile-load-attempted" ]]; then
    [[ -f "$profile_file" && ! -L "$profile_file" &&
       "$(stat -c '%u:%a' -- "$profile_file")" == "$(id -u):600" ]] ||
      fail HERMES_NAMESPACE_SETUP_PROFILE_PATH_INVALID
    sudo apparmor_parser -R "$profile_file"
  fi
  rm -f -- "$profile_file" "${state_dir}/profile-load-attempted" "${state_dir}/probe" "${state_dir}/probe-output"
  rmdir -- "$state_dir"
}

case "${1:-}" in
  cleanup) cleanup; exit 0 ;;
  setup) ;;
  *) fail HERMES_NAMESPACE_SETUP_MODE_INVALID ;;
esac

repository_root="$(realpath -e -- "${GITHUB_WORKSPACE:?}")"
[[ "$(pwd -P)" == "$repository_root" && "$repository_root" != / && "$repository_root" =~ ^/[a-zA-Z0-9_./-]+$ ]] ||
  fail HERMES_NAMESPACE_SETUP_REPOSITORY_PATH_INVALID
launcher="${repository_root}/apps/server/dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher"
[[ -f "$launcher" && -x "$launcher" && ! -L "$launcher" && "$(realpath -e -- "$launcher")" == "$launcher" ]] ||
  fail HERMES_NAMESPACE_SETUP_HELPER_PATH_INVALID
[[ ! -e "$state_dir" ]] || fail HERMES_NAMESPACE_SETUP_STATE_ALREADY_EXISTS
umask 077
mkdir -m 700 -- "$state_dir"
trap cleanup EXIT
"${CXX:-c++}" -std=c++17 -O2 -Wall -Wextra -Wpedantic \
  "-DEBB_NAMESPACE_PROBE_PROFILE_NAME=\"ebb-hermes-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}\"" \
  scripts/linux-hermes-namespace-probe.cpp -o "${state_dir}/probe"

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
     "$probe_result" =~ ^HERMES_NATIVE_NAMESPACE_PROBE:(PASS|HERMES_PRIVATE_NAMESPACE_(UNSHARE|SETGROUPS_MAP|UID_MAP|GID_MAP|SETRESGID|SETRESUID|MOUNT_PROPAGATION)_UNAVAILABLE):ERRNO=[0-9]+$ ]] ||
    fail HERMES_NAMESPACE_SETUP_PROBE_OUTPUT_INVALID
}

run_probe() {
  local unit="ebb-hermes-userns-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-$$.service"
  set +e
  systemd-run --user --quiet --wait --pipe --collect --unit="$unit" \
    --property=Type=exec --property=ExitType=cgroup --property=KillMode=control-group \
    --property=Delegate=no --property=ProtectControlGroups=yes --property=Restart=no \
    "${state_dir}/probe" >"${state_dir}/probe-output" 2>&1
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
  # Runner уже поддерживает contract: никаких AppArmor changes.
  cleanup
  trap - EXIT
  exit 0
fi
[[ "$probe_status" == 70 && "$before_restriction" == 1 &&
   "$probe_result" =~ ^HERMES_NATIVE_NAMESPACE_PROBE:HERMES_PRIVATE_NAMESPACE_UNSHARE_UNAVAILABLE:ERRNO=(1|13)$ ]] ||
  fail HERMES_NAMESPACE_SETUP_UNSUPPORTED_REFUSAL
[[ "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]] ||
  fail HERMES_NAMESPACE_SETUP_APPARMOR_NOT_ACTIVE
command -v apparmor_parser >/dev/null || fail HERMES_NAMESPACE_SETUP_APPARMOR_PARSER_UNAVAILABLE
# Точные validated пути, без wildcard, global sysctl или смены runner.
cat > "$profile_file" <<EOF
abi <abi/4.0>,
include <tunables/global>
profile ebb-hermes-launcher-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT} "$launcher" flags=(default_allow) {
  userns,
}
profile ebb-hermes-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT} "${state_dir}/probe" flags=(default_allow) {
  userns,
}
EOF
touch "${state_dir}/profile-load-attempted"
sudo apparmor_parser -a "$profile_file"
[[ "$(restriction)" == "$before_restriction" ]] || fail HERMES_NAMESPACE_SETUP_GLOBAL_RESTRICTION_CHANGED
run_probe
if [[ "$probe_status" != 0 ]]; then
  # Диагностический control с тем же production call; его PASS не заменяет unit contract.
  unit_context="$probe_context"
  set +e
  "${state_dir}/probe" >"${state_dir}/probe-output" 2>&1
  direct_status=$?
  set -e
  probe_output="$(cat "${state_dir}/probe-output")"
  validate_probe_output
  printf 'HERMES_NATIVE_NAMESPACE_DIRECT_CONTROL:EXIT=%s\n' "$direct_status"
  printf '%s\n' "$probe_output"
  [[ "$unit_context" == HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=EXPECTED_PROFILE:* ]] ||
    fail HERMES_NAMESPACE_SETUP_EXPECTED_PROFILE_NOT_ATTACHED
  fail HERMES_NAMESPACE_SETUP_SCOPED_PROFILE_DID_NOT_RESOLVE_REFUSAL
fi
[[ "$probe_status" == 0 && "$probe_result" == HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0 &&
   "$probe_context" == HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=EXPECTED_PROFILE:* ]] ||
  fail HERMES_NAMESPACE_SETUP_SCOPED_PROFILE_DID_NOT_RESOLVE_REFUSAL
printf 'HERMES_NATIVE_NAMESPACE_SCOPED_APPARMOR_PROFILE=VERIFIED\n'
# Профили остаются до real native acceptance; always-step удаляет их после STOPPED.
trap - EXIT
