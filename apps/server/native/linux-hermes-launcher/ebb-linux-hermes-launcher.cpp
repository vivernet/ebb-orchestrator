#define _GNU_SOURCE

#include <cerrno>
#include <algorithm>
#include <array>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <map>
#include <linux/mount.h>
#include <memory>
#include <sched.h>
#include <string>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unordered_set>
#include <unistd.h>
#include <vector>

extern char** environ;

namespace {

constexpr int kInvalidInput = 64;
constexpr int kPathRejected = 65;
constexpr int kIdentityMismatch = 66;
constexpr int kNamespaceUnavailable = 70;
constexpr int kMountUnavailable = 71;
constexpr int kExecFailed = 127;
constexpr unsigned int kDetachedRecursiveBind = OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH | AT_RECURSIVE;
constexpr unsigned int kMoveDetachedToFd = MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH;
constexpr size_t kMaxProjectionBytes = 64U * 1024U * 1024U;
constexpr size_t kMaxProjectionKeyBytes = 4096;
constexpr uint32_t kMaxProjectionEntries = 100000;
constexpr uint64_t kMaxSnapshotBytes = 1024ULL * 1024ULL * 1024ULL;

volatile sig_atomic_t childPid = 0;

class FileDescriptor {
 public:
  explicit FileDescriptor(int value = -1) : value_(value) {}
  ~FileDescriptor() { if (value_ >= 0) close(value_); }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  FileDescriptor(FileDescriptor&& other) noexcept : value_(other.release()) {}
  FileDescriptor& operator=(FileDescriptor&& other) noexcept {
    if (this != &other) { reset(other.release()); }
    return *this;
  }
  int get() const { return value_; }
  explicit operator bool() const { return value_ >= 0; }
  int release() { const int value = value_; value_ = -1; return value; }
  void reset(int value = -1) { if (value_ >= 0) close(value_); value_ = value; }
 private:
  int value_;
};

class Sha256 {
 public:
  void update(const uint8_t* data, size_t size) {
    total_ += size;
    while (size > 0) {
      const size_t take = std::min(size, block_.size() - used_);
      std::memcpy(block_.data() + used_, data, take);
      used_ += take; data += take; size -= take;
      if (used_ == block_.size()) { transform(block_.data()); used_ = 0; }
    }
  }
  std::array<uint8_t, 32> finish() {
    const uint64_t bits = static_cast<uint64_t>(total_) * 8U;
    block_[used_++] = 0x80;
    if (used_ > 56) { std::fill(block_.begin() + static_cast<ptrdiff_t>(used_), block_.end(), 0); transform(block_.data()); used_ = 0; }
    std::fill(block_.begin() + static_cast<ptrdiff_t>(used_), block_.begin() + 56, 0);
    for (unsigned index = 0; index < 8; ++index) block_[63 - index] = static_cast<uint8_t>(bits >> (index * 8U));
    transform(block_.data());
    std::array<uint8_t, 32> result{};
    for (size_t i = 0; i < state_.size(); ++i) for (unsigned j = 0; j < 4; ++j)
      result[i * 4 + j] = static_cast<uint8_t>(state_[i] >> (24U - j * 8U));
    return result;
  }
 private:
  static uint32_t rotate(uint32_t value, unsigned amount) { return (value >> amount) | (value << (32U - amount)); }
  void transform(const uint8_t* data) {
    static constexpr uint32_t k[64] = {
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
    uint32_t w[64]{};
    for (unsigned i = 0; i < 16; ++i) w[i] = (uint32_t(data[i*4])<<24U)|(uint32_t(data[i*4+1])<<16U)|(uint32_t(data[i*4+2])<<8U)|data[i*4+3];
    for (unsigned i = 16; i < 64; ++i) { const uint32_t a=rotate(w[i-15],7)^rotate(w[i-15],18)^(w[i-15]>>3U); const uint32_t b=rotate(w[i-2],17)^rotate(w[i-2],19)^(w[i-2]>>10U); w[i]=w[i-16]+a+w[i-7]+b; }
    uint32_t a=state_[0],b=state_[1],c=state_[2],d=state_[3],e=state_[4],f=state_[5],g=state_[6],h=state_[7];
    for (unsigned i=0;i<64;++i) { const uint32_t s1=rotate(e,6)^rotate(e,11)^rotate(e,25); const uint32_t ch=(e&f)^(~e&g); const uint32_t t1=h+s1+ch+k[i]+w[i]; const uint32_t s0=rotate(a,2)^rotate(a,13)^rotate(a,22); const uint32_t maj=(a&b)^(a&c)^(b&c); const uint32_t t2=s0+maj; h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; }
    state_[0]+=a;state_[1]+=b;state_[2]+=c;state_[3]+=d;state_[4]+=e;state_[5]+=f;state_[6]+=g;state_[7]+=h;
  }
  std::array<uint32_t,8> state_{{0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}};
  std::array<uint8_t,64> block_{}; size_t used_=0; size_t total_=0;
};

void forwardSignal(int signalNumber) {
  const pid_t pid = static_cast<pid_t>(childPid);
  if (pid > 0) kill(pid, signalNumber);
}

void writeRefusal(const char* reason) {
  std::fprintf(stderr, "HERMES_LINUX_LAUNCH_REFUSED:%s\n", reason);
  std::fflush(stderr);
}

bool parseAbsolutePath(const std::string& value, std::vector<std::string>& components) {
  if (value.empty() || value.front() != '/' || value.size() > 4096 || value.back() == '/' ||
      value.find('\0') != std::string::npos) return false;
  size_t cursor = 1;
  while (cursor < value.size()) {
    const size_t end = value.find('/', cursor);
    const std::string component = value.substr(cursor, end == std::string::npos ? value.size() - cursor : end - cursor);
    if (component.empty() || component == "." || component == "..") return false;
    for (unsigned char character : component) if (character < 0x20 || character == 0x7f) return false;
    components.push_back(component);
    if (end == std::string::npos) break;
    cursor = end + 1;
  }
  return true;
}

bool directoryPermissionsAreSafe(const struct stat& info, uid_t expectedOwner, bool requireOwner) {
  if (!S_ISDIR(info.st_mode)) return false;
  if (requireOwner && info.st_uid != expectedOwner) return false;
  if ((info.st_mode & (S_IWGRP | S_IWOTH)) == 0) return true;
  return !requireOwner && info.st_uid == 0 && (info.st_mode & S_ISVTX) != 0;
}

int openAbsoluteDirectory(const std::string& value, bool requireOwner) {
  std::vector<std::string> components;
  if (!parseAbsolutePath(value, components)) return -1;
  FileDescriptor current(open("/", O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!current) return -1;
  for (size_t index = 0; index < components.size(); ++index) {
    FileDescriptor next(openat(current.get(), components[index].c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (!next) return -1;
    struct stat info{};
    if (fstat(next.get(), &info) != 0 ||
        !directoryPermissionsAreSafe(info, geteuid(), requireOwner && index + 1 == components.size())) return -1;
    current = std::move(next);
  }
  return current.release();
}

int openAbsoluteExecutable(const std::string& value, uint64_t expectedDevice, uint64_t expectedInode) {
  std::vector<std::string> components;
  if (!parseAbsolutePath(value, components) || components.empty()) return -1;
  FileDescriptor parent(open("/", O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!parent) return -1;
  for (size_t index = 0; index + 1 < components.size(); ++index) {
    FileDescriptor next(openat(parent.get(), components[index].c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (!next) return -1;
    struct stat directory{};
    if (fstat(next.get(), &directory) != 0 || !directoryPermissionsAreSafe(directory, geteuid(), false)) return -1;
    parent = std::move(next);
  }
  FileDescriptor executable(openat(parent.get(), components.back().c_str(), O_PATH | O_CLOEXEC | O_NOFOLLOW));
  if (!executable) return -1;
  struct stat info{};
  if (fstat(executable.get(), &info) != 0 || !S_ISREG(info.st_mode) || (info.st_mode & 0111) == 0 ||
      (info.st_mode & (S_IWGRP | S_IWOTH)) != 0 || static_cast<uint64_t>(info.st_dev) != expectedDevice ||
      static_cast<uint64_t>(info.st_ino) != expectedInode) return -1;
  return executable.release();
}

bool parseIdentity(const char* text, uint64_t& result) {
  if (!text || !*text || (text[0] == '0' && text[1] != '\0')) return false;
  char* end = nullptr;
  errno = 0;
  const unsigned long long parsed = std::strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0') return false;
  result = static_cast<uint64_t>(parsed);
  return true;
}

uint32_t readU32Le(const std::vector<uint8_t>& bytes, size_t offset) {
  return uint32_t(bytes[offset]) | (uint32_t(bytes[offset + 1]) << 8U) |
      (uint32_t(bytes[offset + 2]) << 16U) | (uint32_t(bytes[offset + 3]) << 24U);
}

uint16_t readU16Le(const std::vector<uint8_t>& bytes, size_t offset) {
  return static_cast<uint16_t>(uint16_t(bytes[offset]) | (uint16_t(bytes[offset + 1]) << 8U));
}

bool decodeHex(const std::string& text, std::vector<uint8_t>& output) {
  if (text.size() % 2 != 0) return false;
  auto digit = [](char c) -> int { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; return -1; };
  output.clear(); output.reserve(text.size() / 2);
  for (size_t i = 0; i < text.size(); i += 2) { const int high = digit(text[i]), low = digit(text[i + 1]); if (high < 0 || low < 0) return false; output.push_back(static_cast<uint8_t>((high << 4) | low)); }
  return true;
}

std::string hexDigest(const std::array<uint8_t, 32>& digest) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string result; result.reserve(64);
  for (uint8_t byte : digest) { result.push_back(hex[byte >> 4U]); result.push_back(hex[byte & 15U]); }
  return result;
}

struct SnapshotEntry { uint8_t mode; std::array<uint8_t, 32> digest; };

bool validRelativeSnapshotPath(const std::string& path) {
  if (path.empty() || path.size() > 960 || path.front() == '/' || path.find('\\') != std::string::npos || path.find('\0') != std::string::npos) return false;
  size_t start = 0;
  while (start < path.size()) {
    const size_t end = path.find('/', start);
    const std::string segment = path.substr(start, end == std::string::npos ? path.size() - start : end - start);
    if (segment.empty() || segment == "." || segment == "..") return false;
    for (unsigned char ch : segment) if (ch < 0x20 || ch == 0x7f) return false;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

bool readBoundedRegularFile(int directory, const std::string& name, size_t limit, std::vector<uint8_t>& bytes) {
  FileDescriptor file(openat(directory, name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
  struct stat before{};
  if (!file || fstat(file.get(), &before) != 0 || !S_ISREG(before.st_mode) || before.st_nlink != 1 ||
      before.st_uid != geteuid() || (before.st_mode & 0022) != 0 || before.st_size < 0 ||
      static_cast<uint64_t>(before.st_size) > limit) return false;
  bytes.resize(static_cast<size_t>(before.st_size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = read(file.get(), bytes.data() + offset, bytes.size() - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    offset += static_cast<size_t>(count);
  }
  uint8_t extra = 0;
  if (read(file.get(), &extra, 1) != 0) return false;
  struct stat after{};
  return fstat(file.get(), &after) == 0 && before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
      before.st_size == after.st_size && before.st_mtim.tv_sec == after.st_mtim.tv_sec && before.st_mtim.tv_nsec == after.st_mtim.tv_nsec;
}

bool parseSnapshotProjection(const std::vector<uint8_t>& bytes, const std::string& key,
                             const std::string& expectedDigest, const std::string& expectedDirectory,
                             std::map<std::string, SnapshotEntry>& entries) {
  if (bytes.size() < 84 || bytes.size() > kMaxProjectionBytes || std::memcmp(bytes.data(), "EHSP", 4) != 0 ||
      readU16Le(bytes, 4) != 1 || readU16Le(bytes, 6) != 0) return false;
  const uint32_t keyLength = readU32Le(bytes, 8);
  if (keyLength == 0 || keyLength > kMaxProjectionKeyBytes || keyLength != key.size() || bytes.size() < 80U + keyLength + 4U ||
      std::memcmp(bytes.data() + 76, key.data(), key.size()) != 0) return false;
  Sha256 keyHash; keyHash.update(reinterpret_cast<const uint8_t*>(key.data()), key.size());
  const auto keyDigest = keyHash.finish();
  if (hexDigest(keyDigest) != expectedDirectory ||
      !std::equal(keyDigest.begin(), keyDigest.end(), bytes.begin() + 12)) return false;
  std::vector<uint8_t> expectedManifest;
  if (!decodeHex(expectedDigest, expectedManifest) || expectedManifest.size() != 32 ||
      !std::equal(expectedManifest.begin(), expectedManifest.end(), bytes.begin() + 44)) return false;
  const uint32_t count = readU32Le(bytes, 76U + keyLength);
  if (count == 0 || count > kMaxProjectionEntries) return false;
  size_t cursor = 80U + keyLength;
  std::string previous;
  uint64_t pathBytes = 0;
  for (uint32_t i = 0; i < count; ++i) {
    if (cursor + 3 > bytes.size()) return false;
    const uint16_t length = readU16Le(bytes, cursor);
    const uint8_t mode = bytes[cursor + 2]; cursor += 3;
    if (length == 0 || length > 960 || mode > 1 || cursor + length + 32 > bytes.size()) return false;
    std::string path(reinterpret_cast<const char*>(bytes.data() + cursor), length); cursor += length;
    if (!validRelativeSnapshotPath(path) || (!previous.empty() && path <= previous)) return false;
    pathBytes += length;
    if (pathBytes > kMaxSnapshotBytes) return false;
    SnapshotEntry entry{}; entry.mode = mode;
    std::copy_n(bytes.data() + cursor, 32, entry.digest.begin()); cursor += 32;
    if (!entries.emplace(path, entry).second) return false;
    previous = std::move(path);
  }
  return cursor == bytes.size();
}

bool hashSnapshotFile(int file, const struct stat& before, const std::array<uint8_t, 32>& expected) {
  if (!S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_uid != geteuid() || before.st_size < 0 ||
      static_cast<uint64_t>(before.st_size) > kMaxSnapshotBytes) return false;
  Sha256 hash; std::array<uint8_t, 65536> buffer{}; uint64_t total = 0;
  while (true) {
    const ssize_t count = read(file, buffer.data(), buffer.size());
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return false;
    if (count == 0) break;
    total += static_cast<uint64_t>(count); if (total > kMaxSnapshotBytes) return false;
    hash.update(buffer.data(), static_cast<size_t>(count));
  }
  struct stat after{};
  return total == static_cast<uint64_t>(before.st_size) && fstat(file, &after) == 0 &&
      before.st_dev == after.st_dev && before.st_ino == after.st_ino && before.st_size == after.st_size &&
      before.st_mtim.tv_sec == after.st_mtim.tv_sec && before.st_mtim.tv_nsec == after.st_mtim.tv_nsec && hash.finish() == expected;
}

bool verifySnapshotDirectory(int directory, const std::string& prefix, const std::map<std::string, SnapshotEntry>& entries,
                             std::unordered_set<std::string>& seen, uint64_t& totalBytes) {
  FileDescriptor scanFd(dup(directory));
  if (!scanFd) return false;
  DIR* raw = fdopendir(scanFd.release());
  if (!raw) return false;
  std::unique_ptr<DIR, int(*)(DIR*)> stream(raw, closedir);
  while (true) {
    errno = 0;
    dirent* item = readdir(stream.get());
    if (!item) return errno == 0;
    const std::string name(item->d_name);
    if (name == "." || name == "..") continue;
    if (name.find('/') != std::string::npos || name.find('\\') != std::string::npos) return false;
    const std::string path = prefix.empty() ? name : prefix + "/" + name;
    struct stat info{};
    if (fstatat(directory, name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0 || info.st_uid != geteuid() || (info.st_mode & 0022) != 0) return false;
    if (S_ISDIR(info.st_mode)) {
      const std::string prefixSlash = path + "/";
      const bool expectedDirectory = std::any_of(entries.begin(), entries.end(), [&](const auto& entry) { return entry.first.compare(0, prefixSlash.size(), prefixSlash) == 0; });
      if (!expectedDirectory || (info.st_mode & 0777) != 0500) return false;
      FileDescriptor child(openat(directory, name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
      if (!child || !verifySnapshotDirectory(child.get(), path, entries, seen, totalBytes)) return false;
    } else if (S_ISREG(info.st_mode)) {
      const auto found = entries.find(path);
      if (found == entries.end() || !seen.insert(path).second || info.st_nlink != 1 ||
          (info.st_mode & 0777) != (found->second.mode == 1 ? 0500 : 0400)) return false;
      FileDescriptor file(openat(directory, name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
      if (!file || !hashSnapshotFile(file.get(), info, found->second.digest)) return false;
      totalBytes += static_cast<uint64_t>(info.st_size); if (totalBytes > kMaxSnapshotBytes) return false;
    } else return false;
  }
}

bool verifySnapshotTree(int root, const std::map<std::string, SnapshotEntry>& entries) {
  std::unordered_set<std::string> seen; uint64_t total = 0;
  return verifySnapshotDirectory(root, "", entries, seen, total) && seen.size() == entries.size();
}

int acquireSnapshotLease(const std::string& cacheRoot) {
  FileDescriptor directory(openAbsoluteDirectory(cacheRoot, true));
  struct stat rootInfo{};
  if (!directory || fstat(directory.get(), &rootInfo) != 0 || (rootInfo.st_mode & 0777) != 0700) return -1;
  FileDescriptor lock(openat(directory.get(), ".source-cache.ref.lock", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
  struct stat lockInfo{};
  if (!lock || fstat(lock.get(), &lockInfo) != 0 || !S_ISREG(lockInfo.st_mode) || lockInfo.st_uid != geteuid() ||
      lockInfo.st_nlink != 1 || (lockInfo.st_mode & 0777) != 0600 || flock(lock.get(), LOCK_SH | LOCK_NB) != 0) return -1;
  return lock.release();
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

bool writeProcMap(const char* path, const std::string& mapping) {
  FileDescriptor fd(open(path, O_WRONLY | O_CLOEXEC));
  if (!fd) return false;
  const ssize_t written = write(fd.get(), mapping.data(), mapping.size());
  return written == static_cast<ssize_t>(mapping.size());
}

bool enterPrivateMountNamespace(uid_t hostUid, gid_t hostGid) {
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS) != 0) return false;
  if (!writeProcMap("/proc/self/setgroups", "deny\n") ||
      !writeProcMap("/proc/self/uid_map", "0 " + std::to_string(hostUid) + " 1\n") ||
      !writeProcMap("/proc/self/gid_map", "0 " + std::to_string(hostGid) + " 1\n") ||
      setresgid(0, 0, 0) != 0 || setresuid(0, 0, 0) != 0) return false;
  return mount(nullptr, "/", nullptr, MS_REC | MS_PRIVATE, nullptr) == 0;
}

int detachedBind(int sourceFd) {
  return static_cast<int>(syscall(SYS_open_tree, sourceFd, "", kDetachedRecursiveBind));
}

bool makeDetachedMountReadOnly(int mountFd) {
  struct mount_attr attributes{};
  attributes.attr_set = MOUNT_ATTR_RDONLY;
  return syscall(SYS_mount_setattr, mountFd, "", AT_EMPTY_PATH | AT_RECURSIVE, &attributes, sizeof(attributes)) == 0;
}

bool attachDetachedMount(int mountFd, int targetFd) {
  return syscall(SYS_move_mount, mountFd, "", targetFd, "", kMoveDetachedToFd) == 0;
}

bool attachPrivateProfilesTmpfs(int targetFd) {
  FileDescriptor fsContext(static_cast<int>(syscall(SYS_fsopen, "tmpfs", FSOPEN_CLOEXEC)));
  if (!fsContext) return false;
  const bool configured = syscall(SYS_fsconfig, fsContext.get(), FSCONFIG_SET_STRING, "mode", "0700", 0) == 0 &&
      syscall(SYS_fsconfig, fsContext.get(), FSCONFIG_SET_STRING, "size", "1048576", 0) == 0 &&
      syscall(SYS_fsconfig, fsContext.get(), FSCONFIG_SET_FLAG, "nosuid", nullptr, 0) == 0 &&
      syscall(SYS_fsconfig, fsContext.get(), FSCONFIG_SET_FLAG, "nodev", nullptr, 0) == 0 &&
      syscall(SYS_fsconfig, fsContext.get(), FSCONFIG_SET_FLAG, "noexec", nullptr, 0) == 0 &&
      syscall(SYS_fsconfig, fsContext.get(), FSCONFIG_CMD_CREATE, nullptr, nullptr, 0) == 0;
  if (!configured) return false;
  FileDescriptor mountFd(static_cast<int>(syscall(SYS_fsmount, fsContext.get(), FSMOUNT_CLOEXEC, 0)));
  return mountFd && attachDetachedMount(mountFd.get(), targetFd);
}

std::vector<std::string> buildChildEnvironment(const std::string& profilePath) {
  std::vector<std::string> entries;
  for (char** current = environ; current && *current; ++current) {
    const std::string item(*current);
    const size_t separator = item.find('=');
    if (separator == std::string::npos) continue;
    const std::string key = item.substr(0, separator);
    if (key == "HERMES_HOME" || key == "HOME" || key == "HERMES_CONFIG") continue;
    entries.push_back(item);
  }
  entries.push_back("HERMES_HOME=" + profilePath);
  entries.push_back("HOME=" + profilePath + "/home");
  entries.push_back("HERMES_CONFIG=" + profilePath + "/config.yaml");
  return entries;
}

int waitForChild(pid_t pid) {
  struct sigaction action{};
  action.sa_handler = forwardSignal;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, nullptr) != 0 || sigaction(SIGINT, &action, nullptr) != 0) return kExecFailed;
  childPid = pid;
  int status = 0;
  pid_t waited;
  do { waited = waitpid(pid, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited < 0) { childPid = 0; return kExecFailed; }
  childPid = 0;
  int result = WIFEXITED(status) ? WEXITSTATUS(status) : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : kExecFailed);
  while (true) {
    int descendantStatus = 0;
    const pid_t descendant = waitpid(-1, &descendantStatus, 0);
    if (descendant > 0) continue;
    if (descendant < 0 && errno == EINTR) continue;
    if (descendant < 0 && errno == ECHILD) break;
    return kExecFailed;
  }
  return result;
}

int launchHermes(int argc, char** argv) {
  // Args: --run-hermes run-id nonce profile-path profile-dev profile-ino shim-path shim-dev shim-ino
  //       python-path python-dev python-ino snapshot-root root-dev root-ino projection-path projection-sha256
  //       projection-size manifest-sha256 cache-key python-arg-count [exact Python argv...]
  if (argc < 27) return kInvalidInput;
  const std::string runId(argv[2]);
  const std::string nonce(argv[3]);
  const std::string profilePath(argv[4]);
  const std::string shimPath(argv[7]);
  const std::string pythonPath(argv[10]);
  const std::string snapshotRootPath(argv[13]);
  const std::string projectionPath(argv[16]);
  const std::string projectionDigest(argv[17]);
  const std::string manifestDigest(argv[19]);
  const std::string snapshotKey(argv[20]);
  uint64_t expectedProfileDevice = 0;
  uint64_t expectedProfileInode = 0;
  uint64_t expectedShimDevice = 0;
  uint64_t expectedShimInode = 0;
  uint64_t expectedPythonDevice = 0;
  uint64_t expectedPythonInode = 0;
  uint64_t expectedSnapshotDevice = 0;
  uint64_t expectedSnapshotInode = 0;
  uint64_t expectedProjectionSize = 0;
  uint64_t argumentCount = 0;
  if (!isUuidV4(runId) || !isHexNonce(nonce) || !parseIdentity(argv[5], expectedProfileDevice) ||
      !parseIdentity(argv[6], expectedProfileInode) || !parseIdentity(argv[8], expectedShimDevice) ||
      !parseIdentity(argv[9], expectedShimInode) || !parseIdentity(argv[11], expectedPythonDevice) ||
      !parseIdentity(argv[12], expectedPythonInode) || !parseIdentity(argv[14], expectedSnapshotDevice) ||
      !parseIdentity(argv[15], expectedSnapshotInode) || !parseIdentity(argv[18], expectedProjectionSize) ||
      expectedProjectionSize < 84 || expectedProjectionSize > kMaxProjectionBytes ||
      !parseIdentity(argv[21], argumentCount) || argumentCount < 3 || argumentCount > 4096 ||
      argc != static_cast<int>(22 + argumentCount) || argumentCount < 5 || snapshotKey.empty() || snapshotKey.size() > kMaxProjectionKeyBytes ||
      projectionDigest.size() != 64 || manifestDigest.size() != 64) return kInvalidInput;

  std::vector<std::string> profileComponents;
  std::vector<std::string> rootComponents;
  std::vector<std::string> shimComponents;
  std::vector<std::string> snapshotComponents;
  std::vector<std::string> projectionComponents;
  if (!parseAbsolutePath(profilePath, profileComponents) || profileComponents.size() < 3 ||
      profileComponents[profileComponents.size() - 2] != "profiles" ||
      profileComponents.back() != "ebb-orchestrator-run-" + runId ||
      !parseAbsolutePath(shimPath, shimComponents) || !parseAbsolutePath(snapshotRootPath, snapshotComponents) ||
      !parseAbsolutePath(projectionPath, projectionComponents) || std::string(argv[22]) != "-I" ||
      std::string(argv[23]) != "-B" || std::string(argv[24]) != "-S" || std::string(argv[25]) != "-c") return kInvalidInput;
  const std::string directoryId = snapshotComponents.back();
  Sha256 snapshotKeyHash; snapshotKeyHash.update(reinterpret_cast<const uint8_t*>(snapshotKey.data()), snapshotKey.size());
  if (hexDigest(snapshotKeyHash.finish()) != directoryId || projectionPath != snapshotRootPath + ".native-v1.bin" ||
      snapshotComponents.size() < 2 || projectionComponents.size() != snapshotComponents.size() - 1 + 1 ||
      projectionComponents.back() != directoryId + ".native-v1.bin") return kInvalidInput;
  std::string cacheRootPath;
  for (size_t i = 0; i + 1 < snapshotComponents.size(); ++i) cacheRootPath += "/" + snapshotComponents[i];
  if (cacheRootPath.empty()) cacheRootPath = "/";
  if (projectionPath.substr(0, projectionPath.rfind('/')) != cacheRootPath) return kInvalidInput;

  FileDescriptor cacheLease(acquireSnapshotLease(cacheRootPath));
  if (!cacheLease) { writeRefusal("HERMES_SOURCE_CACHE_LEASE_UNAVAILABLE"); return kPathRejected; }
  FileDescriptor snapshotFd(openAbsoluteDirectory(snapshotRootPath, true));
  struct stat snapshotInfo{};
  if (!snapshotFd || fstat(snapshotFd.get(), &snapshotInfo) != 0 || (snapshotInfo.st_mode & 0777) != 0500 ||
      static_cast<uint64_t>(snapshotInfo.st_dev) != expectedSnapshotDevice ||
      static_cast<uint64_t>(snapshotInfo.st_ino) != expectedSnapshotInode) {
    writeRefusal("HERMES_SOURCE_SNAPSHOT_IDENTITY_MISMATCH"); return kIdentityMismatch;
  }
  FileDescriptor cacheRootFd(openAbsoluteDirectory(cacheRootPath, true));
  std::vector<uint8_t> projection;
  std::map<std::string, SnapshotEntry> snapshotEntries;
  const std::string projectionName = directoryId + ".native-v1.bin";
  if (!cacheRootFd || !readBoundedRegularFile(cacheRootFd.get(), projectionName, kMaxProjectionBytes, projection) ||
      projection.size() != expectedProjectionSize) {
    writeRefusal("HERMES_SOURCE_PROJECTION_UNAVAILABLE"); return kIdentityMismatch;
  }
  Sha256 projectionHash; projectionHash.update(projection.data(), projection.size());
  if (hexDigest(projectionHash.finish()) != projectionDigest ||
      !parseSnapshotProjection(projection, snapshotKey, manifestDigest, directoryId, snapshotEntries) ||
      !verifySnapshotTree(snapshotFd.get(), snapshotEntries)) {
    writeRefusal("HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH"); return kIdentityMismatch;
  }
  rootComponents.assign(profileComponents.begin(), profileComponents.end() - 2);
  if (shimComponents.empty()) return kInvalidInput;

  std::string rootPath;
  for (const auto& component : rootComponents) rootPath += "/" + component;
  if (rootPath.empty()) rootPath = "/";
  FileDescriptor rootFd(openAbsoluteDirectory(rootPath, true));
  if (!rootFd) { writeRefusal("HERMES_ROOT_PATH_UNSAFE"); return kPathRejected; }
  FileDescriptor profilesFd(openat(rootFd.get(), "profiles", O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!profilesFd) { writeRefusal("HERMES_PROFILES_PATH_UNSAFE"); return kPathRejected; }
  struct stat profilesInfo{};
  if (fstat(profilesFd.get(), &profilesInfo) != 0 || !directoryPermissionsAreSafe(profilesInfo, geteuid(), true)) {
    writeRefusal("HERMES_PROFILES_PATH_UNSAFE"); return kPathRejected;
  }
  FileDescriptor profileFd(openat(profilesFd.get(), profileComponents.back().c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!profileFd) { writeRefusal("HERMES_PROFILE_PATH_UNSAFE"); return kPathRejected; }
  struct stat profileInfo{};
  if (fstat(profileFd.get(), &profileInfo) != 0 || !directoryPermissionsAreSafe(profileInfo, geteuid(), true) ||
      (profileInfo.st_mode & 0077) != 0 || static_cast<uint64_t>(profileInfo.st_dev) != expectedProfileDevice ||
      static_cast<uint64_t>(profileInfo.st_ino) != expectedProfileInode) {
    writeRefusal("HERMES_PROFILE_IDENTITY_MISMATCH"); return kIdentityMismatch;
  }
  FileDescriptor shimFd(openAbsoluteExecutable(shimPath, expectedShimDevice, expectedShimInode));
  if (!shimFd) { writeRefusal("HERMES_ENTRYPOINT_IDENTITY_MISMATCH"); return kIdentityMismatch; }
  FileDescriptor pythonFd(openAbsoluteExecutable(pythonPath, expectedPythonDevice, expectedPythonInode));
  if (!pythonFd) { writeRefusal("HERMES_PYTHON_IDENTITY_MISMATCH"); return kIdentityMismatch; }
  if (geteuid() != getuid() || getegid() != getgid()) {
    writeRefusal("HERMES_NAMESPACE_CREDENTIALS_UNSUPPORTED"); return kNamespaceUnavailable;
  }

  if (!enterPrivateMountNamespace(getuid(), getgid())) {
    writeRefusal("HERMES_PRIVATE_MOUNT_NAMESPACE_UNAVAILABLE"); return kNamespaceUnavailable;
  }
  if (!attachPrivateProfilesTmpfs(profilesFd.get())) {
    writeRefusal("HERMES_PRIVATE_PROFILES_MOUNT_UNAVAILABLE"); return kMountUnavailable;
  }

  FileDescriptor snapshotTree(detachedBind(snapshotFd.get()));
  if (!snapshotTree || !makeDetachedMountReadOnly(snapshotTree.get()) ||
      !attachDetachedMount(snapshotTree.get(), snapshotFd.get())) {
    writeRefusal("HERMES_SOURCE_SNAPSHOT_READONLY_MOUNT_UNAVAILABLE"); return kMountUnavailable;
  }
  FileDescriptor mountedSnapshotFd(openAbsoluteDirectory(snapshotRootPath, true));
  struct stat mountedSnapshotInfo{};
  if (!mountedSnapshotFd || fstat(mountedSnapshotFd.get(), &mountedSnapshotInfo) != 0 ||
      mountedSnapshotInfo.st_dev != snapshotInfo.st_dev || mountedSnapshotInfo.st_ino != snapshotInfo.st_ino ||
      !verifySnapshotTree(mountedSnapshotFd.get(), snapshotEntries)) {
    writeRefusal("HERMES_SOURCE_SNAPSHOT_MOUNT_VERIFICATION_FAILED"); return kIdentityMismatch;
  }

  // Resolve through the root FD after mounting, so the opened tree is the private tmpfs.
  FileDescriptor privateProfilesFd(openat(rootFd.get(), "profiles", O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!privateProfilesFd || mkdirat(privateProfilesFd.get(), profileComponents.back().c_str(), 0700) != 0) {
    writeRefusal("HERMES_PRIVATE_PROFILE_MOUNTPOINT_UNAVAILABLE"); return kMountUnavailable;
  }
  FileDescriptor profileTargetFd(openat(privateProfilesFd.get(), profileComponents.back().c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  FileDescriptor profileTree(detachedBind(profileFd.get()));
  if (!profileTargetFd || !profileTree || !attachDetachedMount(profileTree.get(), profileTargetFd.get())) {
    writeRefusal("HERMES_PROFILE_MOUNT_UNAVAILABLE"); return kMountUnavailable;
  }

  FileDescriptor mountedProfileFd(openAbsoluteDirectory(profilePath, false));
  struct stat mountedProfileInfo{};
  if (!mountedProfileFd || fstat(mountedProfileFd.get(), &mountedProfileInfo) != 0 ||
      mountedProfileInfo.st_dev != profileInfo.st_dev || mountedProfileInfo.st_ino != profileInfo.st_ino) {
    writeRefusal("HERMES_PROFILE_MOUNT_IDENTITY_MISMATCH"); return kIdentityMismatch;
  }

  std::vector<std::string> childArguments;
  childArguments.reserve(static_cast<size_t>(argumentCount) + 1);
  childArguments.push_back(pythonPath);
  for (uint64_t index = 0; index < argumentCount; ++index) childArguments.emplace_back(argv[22 + index]);
  std::vector<std::string> childEnvironment = buildChildEnvironment(profilePath);
  std::vector<char*> argumentPointers;
  std::vector<char*> environmentPointers;
  for (auto& value : childArguments) argumentPointers.push_back(value.data());
  argumentPointers.push_back(nullptr);
  for (auto& value : childEnvironment) environmentPointers.push_back(value.data());
  environmentPointers.push_back(nullptr);

  struct sigaction defaultAction{};
  defaultAction.sa_handler = SIG_DFL;
  sigemptyset(&defaultAction.sa_mask);
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) {
    writeRefusal("HERMES_PROCESS_SUBREAPER_UNAVAILABLE"); return kNamespaceUnavailable;
  }
  const pid_t child = fork();
  if (child < 0) { writeRefusal("HERMES_PYTHON_FORK_FAILED"); return kExecFailed; }
  if (child == 0) {
    close(3);
    sigaction(SIGTERM, &defaultAction, nullptr);
    sigaction(SIGINT, &defaultAction, nullptr);
    execveat(pythonFd.get(), "", argumentPointers.data(), environmentPointers.data(), AT_EMPTY_PATH);
    writeRefusal("HERMES_EXECVEAT_FAILED");
    _exit(kExecFailed);
  }
  return waitForChild(child);
}

} // namespace

int main(int argc, char** argv) {
  // FD 3 is the authenticated native-helper image inherited from the Node wrapper.
  close(3);
  if (argc < 2 || std::string(argv[1]) != "--run-hermes") return kInvalidInput;
  return launchHermes(argc, argv);
}
