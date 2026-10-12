#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <cerrno>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <string>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

extern char** environ;

namespace {

constexpr int kInvalidInput = 64;
constexpr int kIdentityMismatch = 66;
constexpr int kExecFailed = 127;
volatile sig_atomic_t childPid = 0;

class FileDescriptor {
 public:
  explicit FileDescriptor(int value) : value_(value) {}
  ~FileDescriptor() { if (value_ >= 0) close(value_); }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  int get() const { return value_; }
  explicit operator bool() const { return value_ >= 0; }
 private:
  int value_;
};

void writeRefusal(const char* reason) {
  std::fprintf(stderr, "HERMES_LINUX_LAUNCH_REFUSED:%s\n", reason);
  std::fflush(stderr);
}

bool parseIdentity(const char* text, uint64_t& result) {
  if (!text || !*text || (text[0] == '0' && text[1] != '\0')) return false;
  for (const char* cursor = text; *cursor; ++cursor) if (*cursor < '0' || *cursor > '9') return false;
  char* end = nullptr;
  errno = 0;
  const unsigned long long parsed = std::strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0') return false;
  result = static_cast<uint64_t>(parsed);
  return true;
}

bool isHexNonce(const std::string& value) {
  if (value.size() != 64) return false;
  for (unsigned char character : value) {
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
  }
  return true;
}

bool isUuidV4(const std::string& value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' ||
      value[14] != '4' || (value[19] != '8' && value[19] != '9' && value[19] != 'a' && value[19] != 'b')) return false;
  for (size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    const unsigned char character = static_cast<unsigned char>(value[index]);
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
  }
  return true;
}

int openAbsoluteExecutable(const std::string& path, uint64_t expectedDevice, uint64_t expectedInode) {
  if (path.empty() || path.front() != '/' || path.size() > 4096) return -1;
  // Canonical executable paths and their file identities come from the owning supervisor.
  const int fd = open(path.c_str(), O_PATH | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  struct stat info{};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || (info.st_mode & 0111) == 0 ||
      static_cast<uint64_t>(info.st_dev) != expectedDevice || static_cast<uint64_t>(info.st_ino) != expectedInode) {
    close(fd);
    return -1;
  }
  return fd;
}

std::vector<std::string> buildChildEnvironment() {
  std::vector<std::string> entries;
  for (char** current = environ; current && *current; ++current) {
    const std::string item(*current);
    if (item.find('=') != std::string::npos) entries.push_back(item);
  }
  return entries;
}

void forwardSignal(int signalNumber) {
  const pid_t pid = static_cast<pid_t>(childPid);
  if (pid > 0) kill(pid, signalNumber);
}

int waitForChild(pid_t pid) {
  int status = 0;
  pid_t waited;
  do { waited = waitpid(pid, &status, 0); } while (waited < 0 && errno == EINTR);
  childPid = 0;
  if (waited < 0) return kExecFailed;
  const int result = WIFEXITED(status) ? WEXITSTATUS(status) : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : kExecFailed);
  // The systemd owner stops the whole cgroup; this helper reaps adopted descendants.
  while (true) {
    int descendantStatus = 0;
    const pid_t descendant = waitpid(-1, &descendantStatus, 0);
    if (descendant > 0 || (descendant < 0 && errno == EINTR)) continue;
    return descendant < 0 && errno == ECHILD ? result : kExecFailed;
  }
}

int launchHermes(int argc, char** argv) {
  // v3: run-id nonce shared-home hermes-path/dev/ino python-path/dev/ino arg-count [Python argv...].
  if (argc < 13) return kInvalidInput;
  const std::string runId(argv[2]), nonce(argv[3]), shimPath(argv[5]), pythonPath(argv[8]);
  uint64_t expectedShimDevice = 0, expectedShimInode = 0, expectedPythonDevice = 0, expectedPythonInode = 0, argumentCount = 0;
  if (!isUuidV4(runId) || !isHexNonce(nonce) || !*argv[4] ||
      !parseIdentity(argv[6], expectedShimDevice) || !parseIdentity(argv[7], expectedShimInode) ||
      !parseIdentity(argv[9], expectedPythonDevice) || !parseIdentity(argv[10], expectedPythonInode) ||
      !parseIdentity(argv[11], argumentCount) || argumentCount < 1 || argumentCount > 4096 ||
      argc != static_cast<int>(12 + argumentCount)) return kInvalidInput;

  FileDescriptor shimFd(openAbsoluteExecutable(shimPath, expectedShimDevice, expectedShimInode));
  if (!shimFd) { writeRefusal("HERMES_ENTRYPOINT_IDENTITY_MISMATCH"); return kIdentityMismatch; }
  FileDescriptor pythonFd(openAbsoluteExecutable(pythonPath, expectedPythonDevice, expectedPythonInode));
  if (!pythonFd) { writeRefusal("HERMES_PYTHON_IDENTITY_MISMATCH"); return kIdentityMismatch; }

  std::vector<std::string> childArguments;
  childArguments.reserve(static_cast<size_t>(argumentCount) + 1);
  childArguments.push_back(pythonPath);
  for (uint64_t index = 0; index < argumentCount; ++index) childArguments.emplace_back(argv[12 + index]);
  std::vector<std::string> childEnvironment = buildChildEnvironment();
  std::vector<char*> argumentPointers;
  std::vector<char*> environmentPointers;
  for (auto& value : childArguments) argumentPointers.push_back(value.data());
  argumentPointers.push_back(nullptr);
  for (auto& value : childEnvironment) environmentPointers.push_back(value.data());
  environmentPointers.push_back(nullptr);

  struct sigaction action{};
  action.sa_handler = forwardSignal;
  sigemptyset(&action.sa_mask);
  sigset_t signals, previousMask;
  sigemptyset(&signals);
  sigaddset(&signals, SIGTERM);
  sigaddset(&signals, SIGINT);
  // Block until the child's PID is installed, avoiding a signal lost between fork and wait.
  if (sigprocmask(SIG_BLOCK, &signals, &previousMask) != 0 ||
      sigaction(SIGTERM, &action, nullptr) != 0 || sigaction(SIGINT, &action, nullptr) != 0) {
    writeRefusal("HERMES_SIGNAL_SETUP_FAILED"); return kExecFailed;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) {
    writeRefusal("HERMES_PROCESS_SUBREAPER_UNAVAILABLE"); return kExecFailed;
  }
  const pid_t child = fork();
  if (child < 0) { writeRefusal("HERMES_PYTHON_FORK_FAILED"); return kExecFailed; }
  if (child == 0) {
    action.sa_handler = SIG_DFL;
    if (sigaction(SIGTERM, &action, nullptr) != 0 || sigaction(SIGINT, &action, nullptr) != 0 ||
        sigprocmask(SIG_SETMASK, &previousMask, nullptr) != 0) _exit(kExecFailed);
    execveat(pythonFd.get(), "", argumentPointers.data(), environmentPointers.data(), AT_EMPTY_PATH);
    writeRefusal("HERMES_EXECVEAT_FAILED");
    _exit(kExecFailed);
  }
  childPid = child;
  if (sigprocmask(SIG_SETMASK, &previousMask, nullptr) != 0) {
    kill(child, SIGKILL);
    writeRefusal("HERMES_SIGNAL_SETUP_FAILED");
    waitForChild(child);
    return kExecFailed;
  }
  return waitForChild(child);
}

} // namespace

int main(int argc, char** argv) {
  // FD 3 is the native-helper image inherited from the Node wrapper.
  close(3);
  if (argc < 2 || std::string(argv[1]) != "--run-hermes-v3") return kInvalidInput;
  return launchHermes(argc, argv);
}
