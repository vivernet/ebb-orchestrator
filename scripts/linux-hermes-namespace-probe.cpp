// Probe вызывает production namespace path; отдельной реализации isolation нет.
#define main ebbLinuxHermesLauncherMain
#include "../apps/server/native/linux-hermes-launcher/ebb-linux-hermes-launcher.cpp"
#undef main

#ifndef EBB_NAMESPACE_PROBE_PROFILE_NAME
#error Expected per-run AppArmor profile name must be provided by the prerequisite compiler invocation
#endif

// Label читается ограниченно и преобразуется в enum: raw paths никогда не выводятся.
const char* labelClass() {
  std::array<char, 512> buffer{};
  FileDescriptor labelFd(open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC));
  if (!labelFd) return "UNAVAILABLE";
  const ssize_t count = read(labelFd.get(), buffer.data(), buffer.size());
  if (count <= 0 || count == static_cast<ssize_t>(buffer.size())) return "UNAVAILABLE";
  std::string label(buffer.data(), static_cast<size_t>(count));
  if (!label.empty() && label.back() == '\n') label.pop_back();
  if (label == "unconfined") return "UNCONFINED";
  if (label.find("unprivileged_userns") != std::string::npos) return "RESTRICTED_USERNS";
  const std::string expected(EBB_NAMESPACE_PROBE_PROFILE_NAME);
  if (label == expected || label == expected + " (enforce)" ||
      label == expected + " (allow)" || label == expected + " (unconfined)") return "EXPECTED_PROFILE";
  return "OTHER";
}

int main() {
  if (geteuid() == 0) return kInvalidInput;
  const char* beforeLabel = labelClass();
  const int noNewPrivileges = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  const int seccomp = prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
  const char* failure = enterPrivateMountNamespace(getuid(), getgid());
  const int failureErrno = failure ? errno : 0;
  const char* afterLabel = labelClass();
  std::printf("HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=%s:AFTER=%s:NNP=%d:SECCOMP=%d\n",
              beforeLabel, afterLabel, noNewPrivileges, seccomp);
  // Только фиксированный stage и числовой kernel errno: без путей, argv и stderr.
  std::printf("HERMES_NATIVE_NAMESPACE_PROBE:%s:ERRNO=%d\n", failure ? failure : "PASS", failureErrno);
  return failure ? kNamespaceUnavailable : 0;
}
