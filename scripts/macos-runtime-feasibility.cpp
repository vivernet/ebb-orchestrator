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
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/sysctl.h>
#include <fcntl.h>
#include <spawn.h>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#include <chrono>
#include <algorithm>
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
namespace phase2 {
using Usage = int (*)(uint64_t, void*, size_t);
using ListPids = int (*)(uint32_t, uint32_t, void*, int);
static std::string boot() {
  char buffer[128]{}; size_t size = sizeof(buffer);
  return sysctlbyname("kern.bootsessionuuid", buffer, &size, nullptr, 0) == 0
    ? std::string(buffer, strnlen(buffer, sizeof(buffer))) : std::string();
}
static uint64_t milliseconds() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count());
}
struct Bound { UniqueIdentity unique{}; CoalitionIdentity coalition{}; audit_token_t token{}; };
static bool identity(pid_t pid, Bound& out) {
  auto info = reinterpret_cast<PidInfo>(dlsym(RTLD_DEFAULT, "proc_pidinfo"));
  if (!info) return false;
  UniqueIdentity first{}; CoalitionIdentity before{};
  if (info(pid, 17, 0, &first, sizeof(first)) != static_cast<int>(sizeof(first))
    || info(pid, 20, 0, &before, sizeof(before)) != static_cast<int>(sizeof(before))) return false;
  mach_port_t name = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), pid, &name) != KERN_SUCCESS) return false;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  const auto result = task_info(name, TASK_AUDIT_TOKEN, reinterpret_cast<task_info_t>(&out.token), &count);
  mach_port_deallocate(mach_task_self(), name);
  if (result != KERN_SUCCESS || count != TASK_AUDIT_TOKEN_COUNT
    || info(pid, 17, 0, &out.unique, sizeof(out.unique)) != static_cast<int>(sizeof(out.unique))
    || info(pid, 20, 0, &out.coalition, sizeof(out.coalition)) != static_cast<int>(sizeof(out.coalition))) return false;
  return first.unique != 0 && before.ids[0] != 0
    && first.unique == out.unique.unique && first.version == out.unique.version
    && before.ids[0] == out.coalition.ids[0]
    && out.token.val[5] == static_cast<uint32_t>(pid)
    && out.token.val[7] == static_cast<uint32_t>(out.unique.version);
}
static std::string binding(pid_t pid, const Bound& value) {
  std::string token = "[";
  for (unsigned i = 0; i < 8; ++i) token += (i ? "," : "") + std::to_string(value.token.val[i]);
  return "{\"pid\":" + std::to_string(pid) + ",\"unique\":\"" + std::to_string(value.unique.unique)
    + "\",\"pidversion\":" + std::to_string(value.unique.version) + ",\"coalition\":\""
    + std::to_string(value.coalition.ids[0]) + "\",\"session\":" + std::to_string(getsid(pid)) + ",\"token\":" + token + "]}";
}
static std::vector<Bound> members(uint64_t id, std::vector<pid_t>& identities) {
  auto list = reinterpret_cast<ListPids>(dlsym(RTLD_DEFAULT, "proc_listpids"));
  std::vector<Bound> result;
  if (!list) return result;
  const int required = list(1, 0, nullptr, 0);
  if (required <= 0 || required > 4 * 1024 * 1024) return result;
  std::vector<pid_t> pids(static_cast<size_t>(required) / sizeof(pid_t) + 1024);
  const int returned = list(1, 0, pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
  if (returned <= 0 || static_cast<size_t>(returned) >= pids.size() * sizeof(pid_t)) return result;
  for (int i = 0; i < returned / static_cast<int>(sizeof(pid_t)); ++i) {
    Bound value;
    if (pids[i] > 0 && identity(pids[i], value) && value.coalition.ids[0] == id) {
      identities.push_back(pids[i]); result.push_back(value);
    }
  }
  return result;
}
struct Prefix { uint64_t started, exited; };
static_assert(sizeof(Prefix) == 16);
static_assert(offsetof(Prefix, exited) == 8);
struct Reading { int result = -1, error = 0; Prefix prefix{}; bool valid = false; };
static Reading usage(uint64_t id) {
  auto function = reinterpret_cast<Usage>(dlsym(RTLD_DEFAULT, "coalition_info_resource_usage"));
  Reading out;
  struct { uint64_t before; Prefix data; uint64_t after; } guarded
    {0x0123456789abcdefULL, {UINT64_MAX, UINT64_MAX - 1}, 0xfedcba9876543210ULL};
  if (!function || id == 0) { out.error = ENOTSUP; return out; }
  errno = 0;
  out.result = function(id, &guarded.data, sizeof(Prefix)); out.error = errno;
  out.prefix = guarded.data;
  out.valid = out.result == 0 && guarded.before == 0x0123456789abcdefULL
    && guarded.after == 0xfedcba9876543210ULL && out.prefix.started < UINT64_MAX - 1
    && out.prefix.exited <= out.prefix.started;
  return out;
}
static std::string reading(const Reading& value) {
  return "{\"result\":" + std::to_string(value.result) + ",\"errno\":" + std::to_string(value.error)
    + ",\"requestedBytes\":16,\"returnedBytes\":null,\"validPrefix\":" + (value.valid ? "true" : "false")
    + ",\"started\":\"" + std::to_string(value.prefix.started) + "\",\"exited\":\""
    + std::to_string(value.prefix.exited) + "\"}";
}
static bool transfer(int fd, void* bytes, size_t size, bool writing, uint64_t deadline) {
  auto* buffer = static_cast<unsigned char*>(bytes);
  while (size && milliseconds() < deadline) {
    pollfd item{fd, static_cast<short>(writing ? POLLOUT : POLLIN), 0};
    if (poll(&item, 1, 100) < 0) { if (errno == EINTR) continue; return false; }
    if (!(item.revents & (writing ? POLLOUT : POLLIN))) { if (item.revents & (POLLHUP | POLLERR)) return false; continue; }
    const ssize_t count = writing ? send(fd, buffer, size, 0) : read(fd, buffer, size);
    if (count <= 0) return false;
    size -= static_cast<size_t>(count); buffer += count;
  }
  return size == 0;
}
static bool frame(int fd, std::string& value, bool writing) {
  unsigned char header[4]{}; const uint64_t deadline = milliseconds() + 5000;
  if (writing) {
    if (value.size() > 4096) return false;
    uint32_t count = static_cast<uint32_t>(value.size());
    for (int i = 3; i >= 0; --i) { header[i] = count & 0xff; count >>= 8; }
  }
  if (!transfer(fd, header, 4, writing, deadline)) return false;
  if (!writing) {
    uint32_t count = 0; for (auto byte : header) count = (count << 8) | byte;
    if (count == 0 || count > 4096) return false;
    value.resize(count);
  }
  return transfer(fd, value.data(), value.size(), writing, deadline);
}
static bool ownership(int channel, int& lock, int& peer, bool sending) {
  char tag = 'L'; iovec vector{&tag, 1};
  alignas(cmsghdr) unsigned char control[CMSG_SPACE(2 * sizeof(int))]{};
  msghdr message{}; message.msg_iov = &vector; message.msg_iovlen = 1;
  message.msg_control = control; message.msg_controllen = sizeof(control);
  if (sending) {
    auto* header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(2 * sizeof(int));
    const int descriptors[2]{lock, peer}; std::memcpy(CMSG_DATA(header), descriptors, sizeof(descriptors));
    return sendmsg(channel, &message, 0) == 1;
  }
  pollfd input{channel, POLLIN, 0};
  if (poll(&input, 1, 2000) <= 0 || recvmsg(channel, &message, 0) != 1 || tag != 'L'
    || (message.msg_flags & MSG_CTRUNC)) return false;
  auto* header = CMSG_FIRSTHDR(&message);
  if (!header || CMSG_NXTHDR(&message, header) != nullptr || header->cmsg_level != SOL_SOCKET
    || header->cmsg_type != SCM_RIGHTS || header->cmsg_len != CMSG_LEN(2 * sizeof(int))) return false;
  int descriptors[2]; std::memcpy(descriptors, CMSG_DATA(header), sizeof(descriptors));
  lock = descriptors[0]; peer = descriptors[1]; return lock >= 0 && peer >= 0;
}
static void leaf(uint64_t deadline) {
  while (milliseconds() < deadline) usleep(10000);
  _exit(0);
}
static int fixture(int argc, char** argv) {
  if (argc != 7) return 2;
  const std::string nonce(argv[3]), generation(argv[2]), path(argv[4]), scenario(argv[6]);
  const uint64_t deadline = std::strtoull(argv[5], nullptr, 10);
  if (deadline <= milliseconds() || deadline > milliseconds() + 60000) return 3;
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0 || path.size() >= sizeof(sockaddr_un::sun_path)) return 3;
  sockaddr_un address{}; address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  if (connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) { close(fd); return 3; }
  std::string ready = "{\"protocol\":2,\"generation\":\"" + generation + "\",\"nonce\":\"" + nonce
    + "\",\"scenario\":\"" + scenario + "\"}";
  if (!frame(fd, ready, true)) { close(fd); return 3; }
  std::string ack;
  const std::string expected = "{\"ack\":\"" + nonce + "\",\"generation\":\"" + generation + "\",\"revision\":";
  if (!frame(fd, ack, false) || ack.compare(0, expected.size(), expected) != 0 || ack.back() != '}') {
    close(fd); return 3;
  }
  const std::string revision = ack.substr(expected.size(), ack.size() - expected.size() - 1);
  if (revision.empty() || revision.size() > 10 || revision.find_first_not_of("0123456789") != std::string::npos) { close(fd); return 3; }
  close(fd);
  // Единственная release boundary. До неё нет fork/spawn/exec или fixture payload.
  if (scenario == "fork" || scenario == "root-exit" || scenario == "doublefork" || scenario == "burst" || scenario == "setsid") {
    const unsigned amount = scenario == "burst" ? 12 : 1;
    for (unsigned i = 0; i < amount; ++i) {
      const pid_t child = fork();
      if (child < 0) return 4;
      if (child == 0) {
        if (scenario == "setsid" && setsid() < 0) _exit(4);
        if (scenario == "doublefork" || scenario == "root-exit") {
          if (setsid() < 0) _exit(4);
          const pid_t second = fork(); if (second < 0) _exit(4); if (second > 0) _exit(0);
        }
        if (scenario == "burst" && i == 0) {
          for (unsigned generation = 0; generation < 12; ++generation) {
            usleep(30000);
            const pid_t descendant = fork();
            if (descendant < 0) _exit(4);
            if (descendant == 0) leaf(deadline);
          }
        }
        leaf(deadline);
      }
    }
    if (scenario == "root-exit" || scenario == "doublefork") return 0;
  } else if (scenario == "exec") {
    execl(argv[0], argv[0], "leaf", argv[5], static_cast<char*>(nullptr)); return 4;
  } else if (scenario == "spawn") {
    pid_t child = 0; char* args[]{argv[0], const_cast<char*>("leaf"), argv[5], nullptr};
    char* environment[]{nullptr};
    if (posix_spawn(&child, argv[0], nullptr, nullptr, args, environment) != 0) return 4;
  } else if (scenario != "barrier") return 4;
  leaf(deadline);
  return 0;
}
static int server(int argc, char** argv) {
  if (argc != 6) return 2;
  const std::string path(argv[2]), nonce(argv[3]), generation(argv[4]);
  const uint64_t deadline = std::strtoull(argv[5], nullptr, 10);
  const std::string lockpath = path + ".lock";
  umask(0077);
  const int lock = open(lockpath.c_str(), O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
  struct stat lockstat{};
  if (lock < 0 || fstat(lock, &lockstat) != 0 || !S_ISREG(lockstat.st_mode) || lockstat.st_nlink != 1
    || lockstat.st_uid != getuid() || (lockstat.st_mode & 0077) != 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) return 3;
  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0 || path.size() >= sizeof(sockaddr_un::sun_path)) return 3;
  sockaddr_un address{}; address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  umask(0077);
  if (bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 || listen(fd, 1) != 0) { close(fd); return 3; }
  Bound own;
  if (!identity(getpid(), own)) { close(fd); return 3; }
  std::printf("{\"event\":\"LISTEN\",\"deadline\":\"%llu\",\"controller\":%s}\n",
    static_cast<unsigned long long>(deadline), binding(getpid(), own).c_str()); std::fflush(stdout);
  int peer = -1;
  while (milliseconds() < deadline) {
    pollfd items[2]{{fd, POLLIN, 0}, {STDIN_FILENO, POLLIN | POLLHUP, 0}};
    if (poll(items, 2, 100) < 0) continue;
    if (items[1].revents) { close(fd); return 3; }
    if (items[0].revents & POLLIN) { peer = accept(fd, nullptr, nullptr); break; }
  }
  if (peer < 0) { close(fd); return 3; }
  pid_t pid = 0; socklen_t size = sizeof(pid); uid_t uid = 0; gid_t gid = 0;
  std::string ready; Bound bound;
  if (getsockopt(peer, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) != 0 || size != sizeof(pid)
    || getpeereid(peer, &uid, &gid) != 0 || uid != getuid() || !identity(pid, bound)
    || !frame(peer, ready, false) || ready.size() > 4096) { close(peer); return 3; }
  std::printf("{\"event\":\"READY\",\"root\":%s,\"frame\":%s}\n", binding(pid, bound).c_str(), ready.c_str()); std::fflush(stdout);
  char command[128]{}; size_t used = 0; bool received = false;
  while (milliseconds() < deadline && used + 1 < sizeof(command)) {
    pollfd input{STDIN_FILENO, POLLIN | POLLHUP, 0};
    if (poll(&input, 1, 100) <= 0) continue;
    if (!(input.revents & POLLIN)) break;
    char byte = 0; if (read(STDIN_FILENO, &byte, 1) != 1) break;
    if (byte == '\n') { received = true; break; } command[used++] = byte;
  }
  const std::string expected = "ACK " + nonce + " ";
  const std::string input(command);
  if (received && input == "HANDOFF " + nonce) {
    // Root peer и flock open-file-description передаются вместе; lease ни на мгновение не снимается.
    std::printf("{\"event\":\"HANDOFF\"}\n"); std::fflush(stdout);
    pollfd incoming{fd, POLLIN, 0};
    if (poll(&incoming, 1, 4000) <= 0) { close(peer); close(fd); return 3; }
    const int recovery = accept(fd, nullptr, nullptr);
    uid_t recovery_uid = 0; gid_t recovery_gid = 0; std::string request; Bound fresh;
    const std::string expected_request = "{\"nonce\":\"" + nonce + "\",\"generation\":\"" + generation + "\"}";
    if (recovery < 0 || getpeereid(recovery, &recovery_uid, &recovery_gid) != 0 || recovery_uid != getuid()
      || !frame(recovery, request, false) || request != expected_request || !identity(pid, fresh)
      || fresh.unique.unique != bound.unique.unique || fresh.unique.version != bound.unique.version
      || fresh.coalition.ids[0] != bound.coalition.ids[0]) { close(peer); close(fd); return 3; }
    int transferable_lock = lock, transferable_peer = peer;
    const bool sent = ownership(recovery, transferable_lock, transferable_peer, true) && frame(recovery, ready, true);
    std::string accepted;
    const std::string accepted_prefix = "{\"accepted\":true,\"nonce\":\"" + nonce + "\",\"generation\":\"" + generation
      + "\",\"boot\":\"" + boot() + "\",\"unique\":\"" + std::to_string(fresh.unique.unique)
      + "\",\"pidversion\":" + std::to_string(fresh.unique.version) + ",\"revision\":";
    bool confirmed = sent && frame(recovery, accepted, false) && accepted.compare(0, accepted_prefix.size(), accepted_prefix) == 0
      && accepted.back() == '}';
    if (confirmed) {
      const auto revision = accepted.substr(accepted_prefix.size(), accepted.size() - accepted_prefix.size() - 1);
      confirmed = !revision.empty() && revision.size() <= 10 && revision.find_first_not_of("0123456789") == std::string::npos;
    }
    // Sender сохраняет оба descriptors до receiver ACK после journal reread под переданным flock lease.
    std::string confirmation = confirmed ? "{\"confirmed\":true}" : "{\"confirmed\":false}";
    if (sent) (void)frame(recovery, confirmation, true);
    close(recovery); close(peer); close(fd); return confirmed ? 0 : 3;
  }
  close(fd);
  const auto revision = input.substr(std::min(input.size(), expected.size()));
  if (!received || input.compare(0, expected.size(), expected) != 0 || revision.empty()
    || revision.find_first_not_of("0123456789") != std::string::npos) { close(peer); return 3; }
  Bound fresh;
  if (!identity(pid, fresh) || fresh.unique.unique != bound.unique.unique || fresh.unique.version != bound.unique.version
    || fresh.coalition.ids[0] != bound.coalition.ids[0]) { close(peer); return 3; }
  std::string ack = "{\"ack\":\"" + nonce + "\",\"generation\":\"" + generation + "\",\"revision\":" + revision + "}";
  const bool sent = frame(peer, ack, true); close(peer);
  std::printf("{\"event\":\"RELEASE\",\"sent\":%s}\n", sent ? "true" : "false"); std::fflush(stdout);
  // Scope journal lease остаётся до settlement command pipe, включая after-ACK controller crash.
  while (sent) {
    pollfd input{STDIN_FILENO, POLLIN | POLLHUP, 0};
    if (poll(&input, 1, 100) <= 0) continue;
    char byte = 0; if (read(STDIN_FILENO, &byte, 1) <= 0) break;
  }
  return sent ? 0 : 3;
}
static int stop(uint64_t id) {
  auto list = reinterpret_cast<ListPids>(dlsym(RTLD_DEFAULT, "proc_listpids"));
  auto signal_api = reinterpret_cast<Signal>(dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken"));
  if (!list || !signal_api) return 3;
  const auto deadline = milliseconds() + 30000;
  unsigned signalled = 0, denied = 0;
  Reading current;
  while (milliseconds() < deadline) {
    current = usage(id);
    if ((current.valid && current.prefix.started == current.prefix.exited) || (current.result == -1 && current.error == ESRCH)) break;
    if (!current.valid) break;
    const int required = list(1, 0, nullptr, 0);
    if (required <= 0 || required > 4 * 1024 * 1024) break;
    std::vector<pid_t> pids(static_cast<size_t>(required) / sizeof(pid_t) + 1024);
    const int returned = list(1, 0, pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
    if (returned <= 0 || static_cast<size_t>(returned) >= pids.size() * sizeof(pid_t)) break;
    for (int i = 0; i < returned / static_cast<int>(sizeof(pid_t)); ++i) {
      if (pids[i] <= 0 || pids[i] == getpid()) continue;
      Bound candidate;
      if (!identity(pids[i], candidate) || candidate.coalition.ids[0] != id) continue;
      const int result = signal_api(&candidate.token, SIGKILL);
      if (result == 0) ++signalled; else ++denied;
    }
    usleep(10000);
  }
  const bool empty = current.valid && current.prefix.started == current.prefix.exited;
  const bool absent = current.result == -1 && current.error == ESRCH;
  std::printf("{\"emptyCandidate\":%s,\"absenceCandidate\":%s,\"signalled\":%u,\"denied\":%u,\"usage\":%s}\n",
    empty ? "true" : "false", absent ? "true" : "false", signalled, denied, reading(current).c_str());
  return empty && denied == 0 ? 0 : 3;
}
static int main(int argc, char** argv) {
  const std::string mode(argv[1]);
  if (mode == "fixture") return fixture(argc, argv);
  if (mode == "serve") return server(argc, argv);
  if (mode == "recover-barrier" && argc == 6) {
    const std::string path(argv[2]), nonce(argv[3]), generation(argv[4]);
    if (path.size() >= sizeof(sockaddr_un::sun_path) || boot() != argv[5]) return 3;
    const int channel = socket(AF_UNIX, SOCK_STREAM, 0);
    sockaddr_un address{}; address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
    if (channel < 0 || connect(channel, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      std::printf("{\"event\":\"UNAVAILABLE\"}\n"); return 3;
    }
    pid_t sender_pid = 0; socklen_t sender_size = sizeof(sender_pid); uid_t sender_uid = 0; gid_t sender_gid = 0; Bound sender;
    if (getpeereid(channel, &sender_uid, &sender_gid) != 0 || sender_uid != getuid()
      || getsockopt(channel, SOL_LOCAL, LOCAL_PEERPID, &sender_pid, &sender_size) != 0 || sender_size != sizeof(sender_pid)
      || !identity(sender_pid, sender)) return 3;
    std::string request = "{\"nonce\":\"" + nonce + "\",\"generation\":\"" + generation + "\"}";
    int lock = -1, peer = -1; std::string ready; struct stat value{};
    if (!frame(channel, request, true) || !ownership(channel, lock, peer, false) || !frame(channel, ready, false)
      || fstat(lock, &value) != 0 || !S_ISREG(value.st_mode) || value.st_uid != getuid() || value.st_nlink != 1
      || (value.st_mode & 0077) != 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) return 3;
    pid_t pid = 0; socklen_t size = sizeof(pid); Bound current; uid_t uid = 0; gid_t gid = 0;
    if (getsockopt(peer, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) != 0 || size != sizeof(pid)
      || getpeereid(peer, &uid, &gid) != 0 || uid != getuid() || !identity(pid, current)) return 3;
    std::printf("{\"event\":\"LEASE_BARRIER\",\"root\":%s,\"sender\":%s,\"boot\":\"%s\",\"frame\":%s,\"lockIdentity\":\"%llu:%llu\"}\n",
      binding(pid, current).c_str(), binding(sender_pid, sender).c_str(), boot().c_str(), ready.c_str(), static_cast<unsigned long long>(value.st_dev), static_cast<unsigned long long>(value.st_ino));
    std::fflush(stdout);
    std::string command; char next = 0;
    while (command.size() < 128 && read(STDIN_FILENO, &next, 1) == 1 && next != '\n') command += next;
    const std::string prefix = "ACCEPT " + nonce + " ";
    const std::string revision = command.substr(std::min(command.size(), prefix.size()));
    if (command.compare(0, prefix.size(), prefix) != 0 || revision.empty() || revision.size() > 10
      || revision.find_first_not_of("0123456789") != std::string::npos || boot() != argv[5]) return 3;
    std::string accepted = "{\"accepted\":true,\"nonce\":\"" + nonce + "\",\"generation\":\"" + generation
      + "\",\"boot\":\"" + boot() + "\",\"unique\":\"" + std::to_string(current.unique.unique)
      + "\",\"pidversion\":" + std::to_string(current.unique.version) + ",\"revision\":" + revision + "}";
    std::string confirmation;
    if (!frame(channel, accepted, true) || !frame(channel, confirmation, false) || confirmation != "{\"confirmed\":true}") return 3;
    close(channel);
    std::printf("{\"event\":\"ACCEPTED\",\"revision\":%s}\n", revision.c_str()); std::fflush(stdout);
    // Recover mode никогда не ACK: только удерживает first-party barrier/lease до CLOSED→STOPPED→cleanup.
    char byte; while (read(STDIN_FILENO, &byte, 1) > 0) {}
    close(peer); close(lock); return 0;
  }
  if (mode == "lease" && argc == 3) {
    const int fd = open(argv[2], O_RDWR | O_NOFOLLOW);
    struct stat value{};
    if (fd < 0 || fstat(fd, &value) != 0 || !S_ISREG(value.st_mode) || value.st_nlink != 1
      || value.st_uid != getuid() || (value.st_mode & 0077) != 0) return 3;
    const auto deadline = milliseconds() + 1000;
    while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
      if ((errno != EWOULDBLOCK && errno != EAGAIN) || milliseconds() >= deadline) return 3;
      usleep(10000);
    }
    std::printf("{\"event\":\"LEASE\"}\n"); std::fflush(stdout);
    char byte; while (read(STDIN_FILENO, &byte, 1) > 0) {} close(fd); return 0;
  }
  if (mode == "leaf" && argc == 3) {
    const uint64_t deadline = std::strtoull(argv[2], nullptr, 10);
    if (deadline > milliseconds() + 60000) return 3;
    leaf(deadline); return 0;
  }
  if (mode == "clock" && argc == 2) { std::printf("{\"milliseconds\":\"%llu\",\"boot\":\"%s\",\"socketPathCapacity\":%zu}\n", static_cast<unsigned long long>(milliseconds()), boot().c_str(), sizeof(sockaddr_un::sun_path)); return boot().empty() ? 3 : 0; }
  if (mode == "try-lease" && argc == 3) {
    const int fd = open(argv[2], O_RDWR | O_NOFOLLOW);
    struct stat value{};
    if (fd < 0 || fstat(fd, &value) != 0 || !S_ISREG(value.st_mode) || value.st_nlink != 1
      || value.st_uid != getuid() || (value.st_mode & 0077) != 0) return 3;
    errno = 0; const int result = flock(fd, LOCK_EX | LOCK_NB), error = errno;
    std::printf("{\"acquired\":%s,\"contended\":%s}\n", result == 0 ? "true" : "false",
      result != 0 && (error == EWOULDBLOCK || error == EAGAIN) ? "true" : "false");
    close(fd); return result == 0 ? 0 : 3;
  }
  if (mode == "observe" && argc == 6) {
    const pid_t pid = static_cast<pid_t>(std::strtol(argv[2], nullptr, 10));
    const uint64_t expected = std::strtoull(argv[3], nullptr, 10);
    const int version = static_cast<int>(std::strtol(argv[4], nullptr, 10));
    auto info = reinterpret_cast<PidInfo>(dlsym(RTLD_DEFAULT, "proc_pidinfo"));
    const auto deadline = milliseconds() + 3000;
    if (!info || expected == 0 || pid <= 0 || boot() != argv[5]) { std::printf("{\"state\":\"UNKNOWN\"}\n"); return 3; }
    while (milliseconds() < deadline) {
      UniqueIdentity current{}; errno = 0;
      const int bytes = info(pid, 17, 0, &current, sizeof(current)), error = errno;
      const bool gone = bytes <= 0 && error == ESRCH;
      const bool replaced = bytes == static_cast<int>(sizeof(current)) && current.unique != expected;
      if ((gone || replaced) && boot() == argv[5]) {
        std::printf("{\"state\":\"STOPPED\",\"unique\":\"%llu\",\"pidversion\":%d,\"boot\":\"%s\",\"proofKind\":\"%s\"}\n",
          static_cast<unsigned long long>(expected), version, argv[5], gone ? "BOUND_IDENTITY_PID_SLOT_GONE" : "BOUND_UNIQUE_ID_REPLACED"); return 0;
      }
      if (bytes != static_cast<int>(sizeof(current)) || current.unique != expected || current.version != version) break;
      usleep(10000);
    }
    std::printf("{\"state\":\"UNKNOWN\"}\n"); return 3;
  }
  if (mode == "identity" && argc == 3) {
    Bound value; const pid_t pid = static_cast<pid_t>(std::strtol(argv[2], nullptr, 10));
    if (!identity(pid, value)) { std::printf("{\"identity\":null}\n"); return 3; }
    std::printf("{\"identity\":%s,\"boot\":\"%s\"}\n", binding(pid, value).c_str(), boot().c_str()); return 0;
  }
  if (mode == "usage" && argc == 3) {
    const auto value = usage(std::strtoull(argv[2], nullptr, 10));
    std::printf("%s\n", reading(value).c_str()); return value.valid ? 0 : 3;
  }
  if (mode == "members" && argc == 3) {
    std::vector<pid_t> pids; const auto values = members(std::strtoull(argv[2], nullptr, 10), pids);
    std::string result = "{\"members\":[";
    for (size_t i = 0; i < values.size(); ++i) result += (i ? "," : "") + binding(pids[i], values[i]);
    std::printf("%s]}\n", result.c_str()); return 0;
  }
  if ((mode == "signal" || mode == "stale") && argc == 7) {
    Bound value; const pid_t pid = static_cast<pid_t>(std::strtol(argv[2], nullptr, 10));
    const auto unique = std::strtoull(argv[3], nullptr, 10), id = std::strtoull(argv[5], nullptr, 10);
    const int version = static_cast<int>(std::strtol(argv[4], nullptr, 10));
    const int sig = static_cast<int>(std::strtol(argv[6], nullptr, 10));
    auto function = reinterpret_cast<Signal>(dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken"));
    if (!function || (sig != SIGTERM && sig != SIGKILL) || !identity(pid, value)
      || value.unique.unique != unique || value.coalition.ids[0] != id || (mode == "signal" && value.unique.version != version)) {
      std::printf("{\"result\":-1,\"bound\":false}\n"); return 3;
    }
    if (mode == "stale") value.token.val[7] = static_cast<uint32_t>(version);
    const int result = function(&value.token, sig);
    std::printf("{\"result\":%d,\"bound\":true}\n", result); return result == 0 ? 0 : 3;
  }
  if (mode == "stop" && argc == 3) return stop(std::strtoull(argv[2], nullptr, 10));
  return 2;
}
}
int main(int argc, char** argv) {
  (void)signal(SIGPIPE, SIG_IGN);
  if (argc > 1) return phase2::main(argc, argv);
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
