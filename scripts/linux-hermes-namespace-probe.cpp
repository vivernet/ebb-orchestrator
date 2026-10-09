// Probe вызывает production namespace path; отдельной реализации isolation нет.
#define main ebbLinuxHermesLauncherMain
#include "../apps/server/native/linux-hermes-launcher/ebb-linux-hermes-launcher.cpp"
#undef main

int main() {
  if (geteuid() == 0) return kInvalidInput;
  const char* failure = enterPrivateMountNamespace(getuid(), getgid());
  const int failureErrno = failure ? errno : 0;
  // Только фиксированный stage и числовой kernel errno: без путей, argv и stderr.
  std::printf("HERMES_NATIVE_NAMESPACE_PROBE:%s:ERRNO=%d\n", failure ? failure : "PASS", failureErrno);
  return failure ? kNamespaceUnavailable : 0;
}
