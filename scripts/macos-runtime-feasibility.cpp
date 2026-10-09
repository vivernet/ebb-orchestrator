// Изолированный Phase 1 probe; не является production supervisor.
// SPI ABI pinned: apple-oss-distributions/xnu
// f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_info_private.h
#include <mach/mach.h>
#include <mach/task_info.h>
#include <dlfcn.h>
#include <sys/wait.h>
#include <poll.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#ifdef EBB_PUBLIC_SDK
#include <libproc.h>
#include <sys/proc_info.h>
int main() {
  auto signal_api = &proc_signal_with_audittoken;
  proc_uniqidentifierinfo unique{};
  proc_pidcoalitioninfo coalition{};
  return signal_api == nullptr || sizeof(unique) == 0 || sizeof(coalition) == 0
    || PROC_PIDUNIQIDENTIFIERINFO != 17 || PROC_PIDCOALITIONINFO != 20;
}
#else
struct UniqueIdentity {
  uint8_t uuid[16]; uint64_t unique; uint64_t parent;
  int32_t version; int32_t original_parent_version; uint64_t reserved[2];
};
struct CoalitionIdentity { uint64_t ids[2]; uint64_t reserved[3]; };
static_assert(sizeof(UniqueIdentity) == 56);
static_assert(offsetof(UniqueIdentity, version) == 32);
static_assert(sizeof(CoalitionIdentity) == 40);
static_assert(sizeof(audit_token_t) == 32);
using Signal = int (*)(audit_token_t*, int);
using PidInfo = int (*)(int, int, uint64_t, void*, int);
int main() {
  auto signal_api = reinterpret_cast<Signal>(dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken"));
  auto pid_info = reinterpret_cast<PidInfo>(dlsym(RTLD_DEFAULT, "proc_pidinfo"));
  const bool coalition_export = dlsym(RTLD_DEFAULT, "coalition_info_resource_usage") != nullptr;
  if (!signal_api || !pid_info) {
    std::printf("{\"spiExports\":\"FAIL\",\"permissions\":\"NOT_RUN\",\"cleanup\":\"PASS\"}\n");
    return 1;
  }
  int channel[2];
  if (pipe(channel) != 0) return 2;
  const pid_t child = fork();
  if (child == -1) { close(channel[0]); close(channel[1]); return 2; }
  if (child == 0) {
    close(channel[1]);
    // EOF on controller crash or bounded watchdog releases only this fixture.
    pollfd input{channel[0], POLLIN | POLLHUP, 0};
    (void)poll(&input, 1, 15000);
    close(channel[0]); _exit(0);
  }
  close(channel[0]);
  UniqueIdentity unique{}; CoalitionIdentity coalition{};
  const int unique_bytes = pid_info(child, 17, 0, &unique, sizeof(unique));
  const int coalition_bytes = pid_info(child, 20, 0, &coalition, sizeof(coalition));
  mach_port_t name = MACH_PORT_NULL;
  const kern_return_t name_result = task_name_for_pid(mach_task_self(), child, &name);
  audit_token_t info{};
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  const kern_return_t token_result = name_result == KERN_SUCCESS
    ? task_info(name, TASK_AUDIT_TOKEN, reinterpret_cast<task_info_t>(&info), &count)
    : KERN_FAILURE;
  if (name != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), name);
  const bool identity = unique_bytes == static_cast<int>(sizeof(unique)) && coalition_bytes == static_cast<int>(sizeof(coalition))
    && unique.unique != 0 && coalition.ids[0] != 0 && coalition.ids[1] != 0;
  const bool token_ok = token_result == KERN_SUCCESS && count == TASK_AUDIT_TOKEN_COUNT
    && info.val[5] == static_cast<uint32_t>(child)
    && info.val[7] == static_cast<uint32_t>(unique.version);
  int wrong_result = -1, correct_result = -1, status = 0;
  bool alive = false, stopped = false;
  if (identity && token_ok) {
    audit_token_t wrong = info;
    wrong.val[7] ^= 1U;
    wrong_result = signal_api(&wrong, SIGTERM);
    alive = waitpid(child, &status, WNOHANG) == 0;
    if (wrong_result != 0 && alive) {
      correct_result = signal_api(&info, SIGTERM);
      for (int attempt = 0; attempt < 100; ++attempt) {
        const pid_t waited = waitpid(child, &status, WNOHANG);
        if (waited == child) { stopped = WIFSIGNALED(status) && WTERMSIG(status) == SIGTERM; break; }
        if (waited == -1) break;
        usleep(10000);
      }
    }
  }
  close(channel[1]);
  // Cleanup is fixture-only and is never accepted as token stop proof.
  bool cleaned = stopped;
  if (!cleaned) {
    const pid_t waited = waitpid(child, &status, 0);
    cleaned = waited == child || (waited == -1 && errno == ECHILD);
  }
  const bool passed = identity && token_ok && wrong_result != 0 && alive
    && correct_result == 0 && stopped && cleaned;
  std::printf("{\"spiExports\":\"PASS\",\"coalitionResourceUsageExport\":%s,"
    "\"identityRead\":\"%s\",\"uniqueBytes\":%d,\"coalitionBytes\":%d,"
    "\"taskNameResult\":%d,\"auditTokenResult\":%d,\"wrongTokenResult\":%d,"
    "\"sentinelAliveAfterWrongToken\":%s,\"correctTokenResult\":%d,"
    "\"permissions\":\"%s\",\"cleanup\":\"%s\"}\n",
    coalition_export ? "true" : "false", identity ? "PASS" : "FAIL", unique_bytes,
    coalition_bytes, name_result, token_result, wrong_result, alive ? "true" : "false",
    correct_result, passed ? "PASS" : "FAIL", cleaned ? "PASS" : "FAIL");
  return passed ? 0 : 1;
}
#endif
