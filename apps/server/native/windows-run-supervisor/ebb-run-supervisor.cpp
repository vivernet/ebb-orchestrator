#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <cstring>
#include <map>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr DWORD kMaxMetadataBytes = 256 * 1024;
constexpr DWORD kMaxStringBytes = 16 * 1024;
constexpr DWORD kMaxArgs = 512;
constexpr DWORD kMaxEnvironment = 128;
constexpr DWORD kStopTimeoutMs = 30'000;
constexpr char kMappingMagic[] = "EBBJOB1";
constexpr char kPhaseMappingMagic[] = "EBBPHASE1";
constexpr char kLaunchAckMagic[] = "EBBACK01";
constexpr DWORD kLaunchAckBytes = 8 + 64;

enum LaunchPhase : LONG {
  WAITING_FOR_ACK = 1,
  ACK_ACCEPTED = 2,
  RESUME_API_ERROR = 3,
  RESUME_COUNT_ZERO = 4,
  RESUME_COUNT_ONE = 5,
  RESUME_COUNT_GREATER_THAN_ONE = 6,
};

struct MappingData {
  char magic[8];
  char nonce[65];
  DWORD helperPid;
  ULONGLONG helperCreation;
  DWORD payloadPid;
  ULONGLONG payloadCreation;
  char executableIdentity[72];
};

struct PhaseMappingData {
  char magic[10];
  char nonce[65];
  volatile LONG phase;
};

struct Handle final {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = nullptr; }
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { reset(); value = other.value; other.value = nullptr; }
    return *this;
  }
  void reset(HANDLE handle = nullptr) {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    value = handle;
  }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};

struct CaseInsensitiveLess {
  bool operator()(const std::wstring& left, const std::wstring& right) const {
    return _wcsicmp(left.c_str(), right.c_str()) < 0;
  }
};

struct LaunchMetadata {
  std::wstring executable;
  std::wstring cwd;
  std::vector<std::wstring> args;
  std::map<std::wstring, std::wstring, CaseInsensitiveLess> environment;
  bool hasHermesLaunchIdentity = false;
  std::wstring hermesExecutable;
  std::wstring hermesVolumeSerial;
  std::wstring hermesFileId;
  std::wstring executableVolumeSerial;
  std::wstring executableFileId;
  std::wstring runId;
};

struct Identity {
  DWORD helperPid = 0;
  ULONGLONG helperCreation = 0;
  DWORD payloadPid = 0;
  ULONGLONG payloadCreation = 0;
  std::string executableIdentity;
};

bool isHexId(const std::wstring& value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](wchar_t c) {
    return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f');
  });
}

bool isLowerHex(const std::wstring& value, size_t expectedLength) {
  return value.size() == expectedLength && std::all_of(value.begin(), value.end(), [](wchar_t c) {
    return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f');
  });
}

bool isOwnerState(const std::wstring& value) {
  return value == L"PREPARED" || value == L"LAUNCHING" || value == L"LIVE" ||
    value == L"STOPPING" || value == L"STOPPED" || value == L"UNKNOWN";
}

bool parsePositiveDecimal(const std::wstring& text, ULONGLONG* value) {
  if (text.empty()) return false;
  ULONGLONG parsed = 0;
  for (wchar_t character : text) {
    if (character < L'0' || character > L'9') return false;
    const ULONGLONG digit = static_cast<ULONGLONG>(character - L'0');
    if (parsed > (std::numeric_limits<ULONGLONG>::max() - digit) / 10) return false;
    parsed = parsed * 10 + digit;
  }
  if (parsed == 0) return false;
  *value = parsed;
  return true;
}

bool parseHelperIdentity(
  const std::wstring& pidText,
  const std::wstring& creationText,
  DWORD* pid,
  ULONGLONG* creation,
  bool* present
) {
  if (pidText == L"-" && creationText == L"-") {
    *pid = 0;
    *creation = 0;
    *present = false;
    return true;
  }
  if (pidText == L"-" || creationText == L"-") return false;
  ULONGLONG parsedPid = 0;
  if (!parsePositiveDecimal(pidText, &parsedPid) || parsedPid > MAXDWORD ||
      !parsePositiveDecimal(creationText, creation)) return false;
  *pid = static_cast<DWORD>(parsedPid);
  *present = true;
  return true;
}

bool toAscii(const std::wstring& value, std::string* result) {
  result->clear();
  result->reserve(value.size());
  for (wchar_t character : value) {
    if (character > 0x7f) return false;
    result->push_back(static_cast<char>(character));
  }
  return true;
}

std::wstring jobName(const std::wstring& id) { return L"Local\\ebb-orchestrator-run-" + id; }
std::wstring mappingName(const std::wstring& id) { return L"Local\\ebb-orchestrator-run-meta-" + id; }
std::wstring phaseMappingName(const std::wstring& id) { return L"Local\\ebb-orchestrator-run-phase-" + id; }
bool writeStdout(const std::string& value);

bool isLaunchPhase(LONG phase) {
  return phase == WAITING_FOR_ACK || phase == ACK_ACCEPTED || phase == RESUME_API_ERROR ||
    phase == RESUME_COUNT_ZERO || phase == RESUME_COUNT_ONE || phase == RESUME_COUNT_GREATER_THAN_ONE;
}

const char* launchPhaseName(LaunchPhase phase) {
  switch (phase) {
    case WAITING_FOR_ACK: return "WAITING_FOR_ACK";
    case ACK_ACCEPTED: return "ACK_ACCEPTED";
    case RESUME_API_ERROR: return "RESUME_API_ERROR";
    case RESUME_COUNT_ZERO: return "RESUME_COUNT_ZERO";
    case RESUME_COUNT_ONE: return "RESUME_COUNT_ONE";
    case RESUME_COUNT_GREATER_THAN_ONE: return "RESUME_COUNT_GREATER_THAN_ONE";
    default: return "";
  }
}

bool phaseMappingMatches(const PhaseMappingData* data, const std::wstring& nonce) {
  std::string expectedNonce;
  return data && toAscii(nonce, &expectedNonce) &&
    expectedNonce.size() == 64 &&
    std::memcmp(data->magic, kPhaseMappingMagic, sizeof(kPhaseMappingMagic)) == 0 &&
    std::memcmp(data->nonce, expectedNonce.data(), 64) == 0 && data->nonce[64] == '\0';
}

bool createPhaseMapping(const std::wstring& id, const std::wstring& nonce, Handle* mapping) {
  SetLastError(ERROR_SUCCESS);
  mapping->reset(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(PhaseMappingData), phaseMappingName(id).c_str()));
  const DWORD createError = GetLastError();
  if (!*mapping || createError == ERROR_ALREADY_EXISTS) return false;
  auto* data = static_cast<PhaseMappingData*>(MapViewOfFile(mapping->value, FILE_MAP_WRITE, 0, 0, sizeof(PhaseMappingData)));
  if (!data) return false;
  std::string expectedNonce;
  if (!toAscii(nonce, &expectedNonce) || expectedNonce.size() != 64) {
    UnmapViewOfFile(data);
    return false;
  }
  SecureZeroMemory(data, sizeof(*data));
  std::memcpy(data->magic, kPhaseMappingMagic, sizeof(kPhaseMappingMagic));
  std::memcpy(data->nonce, expectedNonce.data(), expectedNonce.size());
  data->nonce[64] = '\0';
  InterlockedExchange(&data->phase, WAITING_FOR_ACK);
  MemoryBarrier();
  UnmapViewOfFile(data);
  return true;
}

bool writeLaunchPhase(HANDLE mapping, const std::wstring& nonce, LaunchPhase phase) {
  if (!isLaunchPhase(phase)) return false;
  auto* data = static_cast<PhaseMappingData*>(MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, sizeof(PhaseMappingData)));
  if (!data) return false;
  if (!phaseMappingMatches(data, nonce)) {
    UnmapViewOfFile(data);
    return false;
  }
  InterlockedExchange(&data->phase, phase);
  MemoryBarrier();
  UnmapViewOfFile(data);
  return true;
}

bool readLaunchPhase(HANDLE mapping, const std::wstring& nonce, LaunchPhase* phase) {
  auto* data = static_cast<const PhaseMappingData*>(MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(PhaseMappingData)));
  if (!data) return false;
  MemoryBarrier();
  const LONG observedPhase = data->phase;
  const bool valid = phaseMappingMatches(data, nonce) && isLaunchPhase(observedPhase);
  if (valid) *phase = static_cast<LaunchPhase>(observedPhase);
  UnmapViewOfFile(data);
  return valid;
}

bool inspectLaunchPhase(const std::wstring& id, const std::wstring& nonce) {
  Handle mapping(OpenFileMappingW(FILE_MAP_READ, FALSE, phaseMappingName(id).c_str()));
  LaunchPhase phase = WAITING_FOR_ACK;
  if (!mapping || !readLaunchPhase(mapping.value, nonce, &phase)) {
    return writeStdout("UNKNOWN\tPHASE_UNAVAILABLE\n");
  }
  return writeStdout(std::string("PHASE\t") + launchPhaseName(phase) + "\n");
}

bool writeStdout(const std::string& value) {
  DWORD written = 0;
  return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value.data(), static_cast<DWORD>(value.size()), &written, nullptr) &&
    written == value.size();
}

void report(const char* code) {
  writeStdout(std::string("UNKNOWN\t") + code + "\n");
}

// Fixed pre-READY diagnostics remain available when the stdout protocol pipe itself fails.
// Values passed here are compile-time allowlisted operation labels; never include Win32 text or paths.
void reportEarlyLaunchFailure(const char* code) {
  const std::string line = std::string("NATIVE_HELPER_LAUNCH_FAIL:") + code + "\n";
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_ERROR_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
}

bool readExact(void* buffer, DWORD size) {
  auto* bytes = static_cast<unsigned char*>(buffer);
  DWORD offset = 0;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  while (offset < size) {
    DWORD read = 0;
    if (!ReadFile(input, bytes + offset, size - offset, &read, nullptr) || read == 0) return false;
    offset += read;
  }
  return true;
}

bool sha256Buffer(const unsigned char* input, DWORD size, unsigned char digest[32]) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD objectBytes = 0, returned = 0;
  std::vector<unsigned char> object;
  const bool opened = BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
  if (opened && BCRYPT_SUCCESS(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
      reinterpret_cast<PUCHAR>(&objectBytes), sizeof(objectBytes), &returned, 0)) && objectBytes > 0) {
    object.resize(objectBytes);
  }
  const bool created = !object.empty() && BCRYPT_SUCCESS(BCryptCreateHash(algorithm, &hash, object.data(), objectBytes, nullptr, 0, 0));
  const bool updated = created && BCRYPT_SUCCESS(BCryptHashData(hash, const_cast<PUCHAR>(input), size, 0));
  const bool finished = updated && BCRYPT_SUCCESS(BCryptFinishHash(hash, digest, 32, 0));
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!object.empty()) SecureZeroMemory(object.data(), object.size());
  return finished;
}

bool readU32(DWORD* result) {
  unsigned char bytes[4]{};
  if (!readExact(bytes, sizeof(bytes))) return false;
  *result = (static_cast<DWORD>(bytes[0]) << 24) | (static_cast<DWORD>(bytes[1]) << 16) |
    (static_cast<DWORD>(bytes[2]) << 8) | static_cast<DWORD>(bytes[3]);
  return true;
}

bool readString(std::wstring* result, DWORD* remaining) {
  DWORD size = 0;
  if (*remaining < sizeof(DWORD) || !readU32(&size)) return false;
  *remaining -= sizeof(DWORD);
  if (size > kMaxStringBytes || size > *remaining) return false;
  *remaining -= size;
  std::string utf8(size, '\0');
  if (size && !readExact(utf8.data(), size)) return false;
  if (size == 0) { result->clear(); return true; }
  const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(size), nullptr, 0);
  if (required <= 0) return false;
  result->resize(static_cast<size_t>(required));
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(size), result->data(), required)) return false;
  if (result->find(L'\0') != std::wstring::npos) return false;
  return true;
}

bool readFrameU32(DWORD* result, DWORD* remaining) {
  if (*remaining < sizeof(DWORD) || !readU32(result)) return false;
  *remaining -= sizeof(DWORD);
  return true;
}

bool readLaunchAcknowledgement(const std::wstring& nonce) {
  std::array<char, kLaunchAckBytes> received{};
  std::string asciiNonce;
  if (nonce.size() != 64 || !toAscii(nonce, &asciiNonce) || asciiNonce.size() != 64 ||
      !readExact(received.data(), static_cast<DWORD>(received.size()))) return false;
  return memcmp(received.data(), kLaunchAckMagic, sizeof(kLaunchAckMagic) - 1) == 0 &&
    memcmp(received.data() + sizeof(kLaunchAckMagic) - 1, asciiNonce.data(), asciiNonce.size()) == 0;
}

bool allowedEnvironmentName(const std::wstring& name) {
  static const wchar_t* allowed[] = {
    L"HOMEDRIVE", L"HOMEPATH", L"SYSTEMROOT", L"TEMP", L"TMP", L"PATH", L"NODE_PATH", L"NODE_ENV",
    L"USERPROFILE", L"LOCALAPPDATA",
    L"HOME", L"HERMES_HOME", L"HERMES_PROFILE", L"HERMES_CONFIG", L"HERMES_MODEL",
    L"HERMES_DATA_DIR_SUFFIX", L"HERMES_RUNTIME_DIR",
    /* Исключение для ключей LLM-провайдеров: несмотря на суффикс API_KEY,
       OPENAI_API_KEY и ANTHROPIC_API_KEY разрешены для передачи в дочерний процесс. */
    L"OPENAI_API_KEY", L"ANTHROPIC_API_KEY"
  };
  if (name.empty() || !((name[0] >= L'A' && name[0] <= L'Z') || name[0] == L'_')) return false;
  for (wchar_t c : name) if (!((c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'_')) return false;
  for (const auto* candidate : allowed) if (name == candidate) return true;
  return false;
}

bool readMetadata(LaunchMetadata* metadata) {
  DWORD magic = 0, frameByteLength = 0, argCount = 0, envCount = 0;
  if (!readU32(&magic) || (magic != 0x45424233 && magic != 0x45424236) || !readU32(&frameByteLength) ||
      frameByteLength < 16 || frameByteLength > kMaxMetadataBytes) return false;
  DWORD remaining = frameByteLength - 8;
  if (!readFrameU32(&argCount, &remaining) || !readFrameU32(&envCount, &remaining) ||
      argCount > kMaxArgs || envCount > kMaxEnvironment) return false;
  if (!readString(&metadata->executable, &remaining) || !readString(&metadata->cwd, &remaining) ||
      metadata->executable.empty() || metadata->cwd.empty()) return false;
  metadata->args.reserve(argCount);
  for (DWORD index = 0; index < argCount; ++index) {
    std::wstring argument;
    if (!readString(&argument, &remaining)) return false;
    metadata->args.push_back(std::move(argument));
  }
  for (DWORD index = 0; index < envCount; ++index) {
    std::wstring key, value;
    if (!readString(&key, &remaining) || !readString(&value, &remaining) || !allowedEnvironmentName(key) ||
        value.find(L'\0') != std::wstring::npos || value.find(L'\r') != std::wstring::npos ||
        value.find(L'\n') != std::wstring::npos || !metadata->environment.emplace(key, value).second) return false;
  }
  DWORD hasHermesLaunchIdentity = 0;
  if (!readFrameU32(&hasHermesLaunchIdentity, &remaining) || hasHermesLaunchIdentity > 1) return false;
  metadata->hasHermesLaunchIdentity = hasHermesLaunchIdentity == 1;
  if ((metadata->hasHermesLaunchIdentity && magic != 0x45424236) ||
      (!metadata->hasHermesLaunchIdentity && magic != 0x45424233)) return false;
  if (metadata->hasHermesLaunchIdentity) {
    if (!readString(&metadata->hermesExecutable, &remaining) ||
        !readString(&metadata->hermesVolumeSerial, &remaining) ||
        !readString(&metadata->hermesFileId, &remaining) ||
        !readString(&metadata->executableVolumeSerial, &remaining) ||
        !readString(&metadata->executableFileId, &remaining) ||
        !readString(&metadata->runId, &remaining)) return false;
    if (metadata->hermesExecutable.empty() || metadata->hermesVolumeSerial.size() != 16 ||
        metadata->hermesFileId.size() != 32 || metadata->executableVolumeSerial.size() != 16 ||
        metadata->executableFileId.size() != 32 ||
        metadata->runId.size() != 36 || metadata->runId[8] != L'-' || metadata->runId[13] != L'-' ||
        metadata->runId[18] != L'-' || metadata->runId[23] != L'-' || metadata->runId[14] != L'4' ||
        (metadata->runId[19] != L'8' && metadata->runId[19] != L'9' && metadata->runId[19] != L'a' && metadata->runId[19] != L'b')) return false;
    for (size_t index = 0; index < metadata->runId.size(); ++index) {
      if (index == 8 || index == 13 || index == 18 || index == 23) continue;
      const wchar_t c = metadata->runId[index];
      if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
    }
    if (!isLowerHex(metadata->hermesVolumeSerial, 16) || !isLowerHex(metadata->hermesFileId, 32) ||
        !isLowerHex(metadata->executableVolumeSerial, 16) || !isLowerHex(metadata->executableFileId, 32)) return false;
  }
  return remaining == 0;
}

bool ticketFileIdentity(HANDLE handle, const std::wstring& expectedVolume, const std::wstring& expectedFileId) {
  FILE_ID_INFO identity{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity))) return false;
  wchar_t volume[17]{};
  swprintf_s(volume, L"%016llx", static_cast<unsigned long long>(identity.VolumeSerialNumber));
  if (expectedVolume != volume) return false;
  static constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring fileId;
  fileId.reserve(sizeof(identity.FileId.Identifier) * 2);
  for (const unsigned char byte : identity.FileId.Identifier) {
    fileId.push_back(hex[(byte >> 4) & 0x0f]);
    fileId.push_back(hex[byte & 0x0f]);
  }
  return expectedFileId == fileId;
}

bool launchObjectCommitment(const char* stage, const LaunchMetadata& metadata, std::string* digestHex) {
  std::string runId, executableVolume, executableFile, hermesVolume, hermesFile;
  if (!toAscii(metadata.runId, &runId) || !toAscii(metadata.executableVolumeSerial, &executableVolume) ||
      !toAscii(metadata.executableFileId, &executableFile) || !toAscii(metadata.hermesVolumeSerial, &hermesVolume) ||
      !toAscii(metadata.hermesFileId, &hermesFile)) return false;
  const std::string canonical = std::string("EBB-LAUNCH-OBJECT-EVIDENCE-V3\n") + stage + "\n" + runId + "\n" +
    executableVolume + ":" + executableFile + "\n" + hermesVolume + ":" + hermesFile + "\n";
  unsigned char digest[32]{};
  if (!sha256Buffer(reinterpret_cast<const unsigned char*>(canonical.data()), static_cast<DWORD>(canonical.size()), digest)) return false;
  static constexpr char hex[] = "0123456789abcdef";
  digestHex->clear();
  for (const auto byte : digest) { digestHex->push_back(hex[byte >> 4]); digestHex->push_back(hex[byte & 0x0f]); }
  SecureZeroMemory(digest, sizeof(digest));
  return true;
}

bool addEvidenceRecord(std::vector<std::string>* records, const char* stage, const std::wstring& owner,
                       const std::wstring& nonce, const LaunchMetadata& metadata, const std::string& digest) {
  std::string ownerAscii, nonceAscii, runId;
  if (!toAscii(owner, &ownerAscii) || !toAscii(nonce, &nonceAscii) || !toAscii(metadata.runId, &runId) ||
      ownerAscii.size() != 64 || nonceAscii.size() != 64 || digest.size() != 64 || records->size() >= 5) return false;
  records->push_back(std::string("EBB_EVIDENCE\tV3\t") + stage + "\t" + ownerAscii + "\t" + runId + "\t" + nonceAscii + "\t" + digest + "\n");
  return records->back().size() <= 512;
}

bool openTicketExecutable(const LaunchMetadata& metadata, Handle* handle) {
  handle->reset(CreateFileW(metadata.executable.c_str(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!*handle) return false;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return GetFileInformationByHandleEx(handle->value, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
    (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
    ticketFileIdentity(handle->value, metadata.executableVolumeSerial, metadata.executableFileId);
}

bool openTicketHermesLauncher(const LaunchMetadata& metadata, Handle* handle) {
  handle->reset(CreateFileW(metadata.hermesExecutable.c_str(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!*handle) return false;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return GetFileInformationByHandleEx(handle->value, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
    (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
    ticketFileIdentity(handle->value, metadata.hermesVolumeSerial, metadata.hermesFileId);
}

bool processImageMatchesTicket(HANDLE process, HANDLE expectedExecutable) {
  std::vector<wchar_t> path(32'768);
  DWORD length = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process, 0, path.data(), &length) || length == 0) return false;
  const std::wstring imagePath(path.data(), length);
  Handle image(CreateFileW(imagePath.c_str(), FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!image) return false;
  FILE_ID_INFO expected{}, actual{};
  return GetFileInformationByHandleEx(expectedExecutable, FileIdInfo, &expected, sizeof(expected)) &&
    GetFileInformationByHandleEx(image.value, FileIdInfo, &actual, sizeof(actual)) &&
    expected.VolumeSerialNumber == actual.VolumeSerialNumber &&
    memcmp(expected.FileId.Identifier, actual.FileId.Identifier, sizeof(expected.FileId.Identifier)) == 0;
}

bool ticketPathsStillMatch(const LaunchMetadata& metadata, HANDLE executable, HANDLE hermes,
                           std::string* verifiedCommitment = nullptr, const char* commitmentStage = nullptr) {
  Handle currentExecutable, currentHermes;
  return openTicketExecutable(metadata, &currentExecutable) && openTicketHermesLauncher(metadata, &currentHermes) &&
    ticketFileIdentity(executable, metadata.executableVolumeSerial, metadata.executableFileId) &&
    ticketFileIdentity(hermes, metadata.hermesVolumeSerial, metadata.hermesFileId) &&
    (!verifiedCommitment || (commitmentStage && launchObjectCommitment(commitmentStage, metadata, verifiedCommitment)));
}

std::wstring quoteArgument(const std::wstring& argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) return argument;
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t c : argument) {
    if (c == L'\\') { ++backslashes; continue; }
    if (c == L'\"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(c);
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(c);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

std::wstring commandLine(const LaunchMetadata& metadata) {
  std::wstring result = quoteArgument(metadata.executable);
  for (const auto& argument : metadata.args) { result.push_back(L' '); result += quoteArgument(argument); }
  return result;
}

std::vector<wchar_t> environmentBlock(const LaunchMetadata& metadata) {
  std::vector<wchar_t> block;
  size_t characters = metadata.environment.empty() ? 2 : 1;
  for (const auto& [key, value] : metadata.environment) characters += key.size() + value.size() + 2;
  block.reserve(characters);
  for (const auto& [key, value] : metadata.environment) {
    block.insert(block.end(), key.begin(), key.end());
    block.push_back(L'=');
    block.insert(block.end(), value.begin(), value.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  if (metadata.environment.empty()) block.push_back(L'\0');
  return block;
}

bool processCreationTime(HANDLE process, ULONGLONG* creation) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return false;
  *creation = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  return *creation != 0;
}

bool processInventoryConfirmsHelperAbsent(DWORD helperPid, ULONGLONG expectedCreation, bool* absent) {
  *absent = false;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) return false;

  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) {
    if (GetLastError() != ERROR_NO_MORE_FILES) return false;
    *absent = true;
    return true;
  }
  bool found = false;
  do {
    if (entry.th32ProcessID == helperPid) found = true;
  } while (Process32NextW(snapshot.value, &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES) return false;
  if (!found) { *absent = true; return true; }

  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, helperPid));
  if (!process) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) { *absent = true; return true; }
    return false;
  }
  ULONGLONG actualCreation = 0;
  if (!processCreationTime(process.value, &actualCreation)) return false;
  if (actualCreation != expectedCreation) { *absent = true; return true; }
  const DWORD processState = WaitForSingleObject(process.value, 0);
  if (processState == WAIT_OBJECT_0) { *absent = true; return true; }
  if (processState == WAIT_TIMEOUT) return true;
  return false;
}

bool processExecutableIdentity(HANDLE process, std::string* identity) {
  std::vector<wchar_t> path(32'768);
  DWORD pathLength = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process, 0, path.data(), &pathLength) || pathLength == 0) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  ULONG objectLength = 0, received = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength), &received, 0) < 0 ||
      received != sizeof(objectLength)) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::vector<UCHAR> object(objectLength);
  UCHAR digest[32]{};
  bool succeeded = BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0) >= 0 &&
    BCryptHashData(hash, reinterpret_cast<PUCHAR>(path.data()), pathLength * sizeof(wchar_t), 0) >= 0 &&
    BCryptFinishHash(hash, digest, sizeof(digest), 0) >= 0;
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!succeeded) { SecureZeroMemory(digest, sizeof(digest)); return false; }
  static constexpr char hex[] = "0123456789abcdef";
  identity->assign("sha256:");
  for (UCHAR byte : digest) {
    identity->push_back(hex[(byte >> 4) & 0x0f]);
    identity->push_back(hex[byte & 0x0f]);
  }
  SecureZeroMemory(digest, sizeof(digest));
  return true;
}

bool queryJob(HANDLE job, DWORD* active, std::vector<ULONG_PTR>* processIds) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return false;
  *active = accounting.ActiveProcesses;
  if (*active == 0) { processIds->clear(); return true; }
  DWORD capacity = std::max<DWORD>(*active, 8);
  while (capacity <= 65536) {
    const size_t bytes = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * (capacity - 1);
    std::vector<unsigned char> storage(bytes);
    auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
    list->NumberOfAssignedProcesses = 0;
    list->NumberOfProcessIdsInList = capacity;
    if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(bytes), nullptr)) {
      if (GetLastError() == ERROR_MORE_DATA) { capacity *= 2; continue; }
      return false;
    }
    if (list->NumberOfAssignedProcesses != *active || list->NumberOfProcessIdsInList != *active) return false;
    processIds->assign(list->ProcessIdList, list->ProcessIdList + list->NumberOfProcessIdsInList);
    return true;
  }
  return false;
}

bool queryJobActiveProcessCount(HANDLE job, DWORD* active) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return false;
  *active = accounting.ActiveProcesses;
  return true;
}

bool launchControlChannelHealthy() {
  DWORD available = 0;
  if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) return false;
  return available == 0;
}

bool readMapping(HANDLE mapping, const std::wstring& nonce, Identity* identity) {
  auto* data = static_cast<const MappingData*>(MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(MappingData)));
  if (!data) return false;
  std::string expectedNonce;
  if (!toAscii(nonce, &expectedNonce)) { UnmapViewOfFile(data); return false; }
  const bool valid = std::memcmp(data->magic, kMappingMagic, sizeof(kMappingMagic)) == 0 &&
    std::string(data->nonce, data->nonce + 64) == expectedNonce && data->nonce[64] == '\0' &&
    data->helperPid > 0 && data->helperCreation > 0 && data->payloadPid > 0 && data->payloadCreation > 0;
  if (valid) {
    identity->helperPid = data->helperPid;
    identity->helperCreation = data->helperCreation;
    identity->payloadPid = data->payloadPid;
    identity->payloadCreation = data->payloadCreation;
    if (data->executableIdentity[71] != '\0') {
      UnmapViewOfFile(data);
      return false;
    }
    identity->executableIdentity.assign(data->executableIdentity);
    if (identity->executableIdentity.size() != 71 || identity->executableIdentity.rfind("sha256:", 0) != 0) {
      UnmapViewOfFile(data);
      return false;
    }
  }
  UnmapViewOfFile(data);
  return valid;
}

bool writeMapping(HANDLE mapping, const std::wstring& nonce, const Identity& identity) {
  auto* data = static_cast<MappingData*>(MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, sizeof(MappingData)));
  if (!data) return false;
  SecureZeroMemory(data, sizeof(*data));
  std::memcpy(data->magic, kMappingMagic, sizeof(kMappingMagic));
  for (size_t index = 0; index < 64; ++index) data->nonce[index] = static_cast<char>(nonce[index]);
  data->nonce[64] = '\0';
  data->helperPid = identity.helperPid;
  data->helperCreation = identity.helperCreation;
  data->payloadPid = identity.payloadPid;
  data->payloadCreation = identity.payloadCreation;
  if (identity.executableIdentity.size() != 71) { UnmapViewOfFile(data); return false; }
  std::memcpy(data->executableIdentity, identity.executableIdentity.c_str(), identity.executableIdentity.size() + 1);
  MemoryBarrier();
  UnmapViewOfFile(data);
  return true;
}

bool openOwnerObjects(const std::wstring& id, const std::wstring& nonce, Handle* job, Handle* mapping, Identity* identity) {
  job->reset(OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE, FALSE, jobName(id).c_str()));
  if (!*job) return false;
  mapping->reset(OpenFileMappingW(FILE_MAP_READ, FALSE, mappingName(id).c_str()));
  if (!*mapping || !readMapping(mapping->value, nonce, identity)) return false;
  return true;
}

bool printIdentity(const char* state, const std::wstring& id, const std::wstring& nonce, const Identity& identity) {
  std::string asciiId, asciiNonce;
  if (!toAscii(id, &asciiId) || !toAscii(nonce, &asciiNonce)) return false;
  const auto line = std::string(state) + "\t" + asciiId + "\t" + asciiNonce + "\t" +
    std::to_string(identity.helperPid) + "\t" + std::to_string(identity.helperCreation) + "\t" +
    std::to_string(identity.payloadPid) + "\t" + std::to_string(identity.payloadCreation) + "\t" + identity.executableIdentity + "\n";
  return writeStdout(line);
}

bool createChildHandles(Handle* input, Handle* output, Handle* error) {
  HANDLE sourceOut = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE sourceErr = GetStdHandle(STD_ERROR_HANDLE);
  if (!DuplicateHandle(GetCurrentProcess(), sourceOut, GetCurrentProcess(), &output->value, 0, TRUE, DUPLICATE_SAME_ACCESS) ||
      !DuplicateHandle(GetCurrentProcess(), sourceErr, GetCurrentProcess(), &error->value, 0, TRUE, DUPLICATE_SAME_ACCESS)) return false;
  input->reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!*input) return false;
  return SetHandleInformation(input->value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != FALSE;
}

bool launch(const std::wstring& id, const std::wstring& nonce, DWORD* payloadExitCode, bool acceptanceEvidence = false) {
  SetLastError(ERROR_SUCCESS);
  Handle job(CreateJobObjectW(nullptr, jobName(id).c_str()));
  const DWORD jobCreateError = GetLastError();
  if (!job || jobCreateError == ERROR_ALREADY_EXISTS) {
    report("JOB_CREATE_FAILED_OR_EXISTS");
    reportEarlyLaunchFailure("JOB_CREATE_FAILED_OR_EXISTS");
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    report("JOB_POLICY_FAILED");
    reportEarlyLaunchFailure("JOB_POLICY_FAILED");
    return false;
  }

  SetLastError(ERROR_SUCCESS);
  Handle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(MappingData), mappingName(id).c_str()));
  const DWORD mappingCreateError = GetLastError();
  if (!mapping || mappingCreateError == ERROR_ALREADY_EXISTS) {
    report("MAPPING_CREATE_FAILED_OR_EXISTS");
    reportEarlyLaunchFailure("MAPPING_CREATE_FAILED_OR_EXISTS");
    return false;
  }
  if (!writeStdout("EBB_HELPER_READY\n")) {
    reportEarlyLaunchFailure("HELPER_READY_WRITE_FAILED");
    return false;
  }
  LaunchMetadata metadata;
  if (!readMetadata(&metadata)) { report("LAUNCH_FRAME_INVALID"); return false; }
  if (acceptanceEvidence && !metadata.hasHermesLaunchIdentity) { report("LAUNCH_FRAME_INVALID"); return false; }
  std::vector<std::string> evidenceRecords;
  if (acceptanceEvidence) {
    std::string digest;
    if (!launchObjectCommitment("FRAME_DECODED_EXPECTED", metadata, &digest) ||
        !addEvidenceRecord(&evidenceRecords, "FRAME_DECODED_EXPECTED", id, nonce, metadata, digest)) {
      report("LAUNCH_FRAME_INVALID"); return false;
    }
  }

  Handle ticketExecutable;
  Handle ticketHermes;
  if (metadata.hasHermesLaunchIdentity) {
    if (!openTicketExecutable(metadata, &ticketExecutable)) { report("LAUNCH_TICKET_EXECUTABLE_MISMATCH"); return false; }
    if (!openTicketHermesLauncher(metadata, &ticketHermes)) { report("LAUNCH_TICKET_HERMES_MISMATCH"); return false; }

  }
  if (acceptanceEvidence) {
    std::string digest;
    if (!launchObjectCommitment("SUPERVISOR_OPEN", metadata, &digest) ||
        !addEvidenceRecord(&evidenceRecords, "SUPERVISOR_OPEN", id, nonce, metadata, digest)) {
      report("HERMES_TICKET_OBJECT_MISMATCH"); return false;
    }
  }

  Handle childInput, childOutput, childError;
  if (!createChildHandles(&childInput, &childOutput, &childError)) { report("CHILD_STDIO_FAILED"); return false; }
  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeBytes);
  std::vector<unsigned char> attributes(attributeBytes);
  auto* attributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(attributeList, 2, 0, &attributeBytes)) { report("CHILD_ATTRIBUTE_INIT_FAILED"); return false; }
  HANDLE inherited[] = { childInput.value, childOutput.value, childError.value };
  if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributeList); report("CHILD_HANDLE_ALLOWLIST_FAILED"); return false;
  }
  HANDLE assignedJobs[] = { job.value };
  if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, assignedJobs, sizeof(assignedJobs), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributeList); report("CHILD_JOB_BARRIER_UNAVAILABLE"); return false;
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = childInput.value;
  startup.StartupInfo.hStdOutput = childOutput.value;
  startup.StartupInfo.hStdError = childError.value;
  startup.lpAttributeList = attributeList;
  PROCESS_INFORMATION process{};
  std::wstring line = commandLine(metadata);
  auto environment = environmentBlock(metadata);
  if (line.size() >= 32'767 || environment.size() >= 32'767) {
    DeleteProcThreadAttributeList(attributeList);
    SecureZeroMemory(environment.data(), environment.size() * sizeof(wchar_t));
    report("CHILD_STARTUP_FRAME_TOO_LARGE");
    return false;
  }
  if (metadata.hasHermesLaunchIdentity) {
    std::string digest;
    if (!ticketPathsStillMatch(metadata, ticketExecutable.value, ticketHermes.value, &digest, "PRE_CREATE") ||
        (acceptanceEvidence && !addEvidenceRecord(&evidenceRecords, "PRE_CREATE", id, nonce, metadata, digest))) {
      DeleteProcThreadAttributeList(attributeList);
      SecureZeroMemory(environment.data(), environment.size() * sizeof(wchar_t));
      report("HERMES_TICKET_OBJECT_MISMATCH"); return false;
    }
  }
  const BOOL created = CreateProcessW(metadata.executable.c_str(), line.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment.data(), metadata.cwd.c_str(),
    &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(attributeList);
  SecureZeroMemory(environment.data(), environment.size() * sizeof(wchar_t));
  if (!created) { report("CHILD_CREATE_FAILED"); return false; }
  Handle payload(process.hProcess);
  Handle primaryThread(process.hThread);

  BOOL member = FALSE;
  if (!IsProcessInJob(payload.value, job.value, &member) || !member) {
    TerminateProcess(payload.value, 1); WaitForSingleObject(payload.value, 5'000); report("CHILD_JOB_ASSIGNMENT_FAILED"); return false;
  }
  DWORD active = 0;
  std::vector<ULONG_PTR> processIds;
  if (!queryJob(job.value, &active, &processIds) || active != 1 || processIds.size() != 1 || processIds[0] != process.dwProcessId) {
    TerminateJobObject(job.value, 1); WaitForSingleObject(payload.value, 5'000); report("CHILD_JOB_MEMBERSHIP_UNPROVEN"); return false;
  }
  if (metadata.hasHermesLaunchIdentity &&
      (!processImageMatchesTicket(payload.value, ticketExecutable.value) ||
       !ticketPathsStillMatch(metadata, ticketExecutable.value, ticketHermes.value))) {
    TerminateJobObject(job.value, 1); WaitForSingleObject(payload.value, 5'000);
    report("HERMES_TICKET_OBJECT_MISMATCH"); return false;
  }
  Identity identity{};
  identity.helperPid = GetCurrentProcessId();
  identity.payloadPid = process.dwProcessId;
  if (!processCreationTime(GetCurrentProcess(), &identity.helperCreation) || !processCreationTime(payload.value, &identity.payloadCreation) ||
      !processExecutableIdentity(payload.value, &identity.executableIdentity) ||
      !writeMapping(mapping.value, nonce, identity)) {
    TerminateJobObject(job.value, 1); WaitForSingleObject(payload.value, 5'000); report("CHILD_IDENTITY_PERSIST_FAILED"); return false;
  }
  Handle phaseMapping;
  if (!createPhaseMapping(id, nonce, &phaseMapping)) {
    TerminateJobObject(job.value, 1); WaitForSingleObject(payload.value, 5'000); report("PHASE_MAPPING_CREATE_FAILED"); return false;
  }
  if (!printIdentity("EBB_SCOPE_READY", id, nonce, identity)) {
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(payload.value, 5'000);
    report("IDENTITY_OUTPUT_FAILED");
    return false;
  }
  if (!readLaunchAcknowledgement(nonce)) {
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(payload.value, 5'000);
    report("LAUNCH_ACK_REJECTED");
    return false;
  }
  if (!writeLaunchPhase(phaseMapping.value, nonce, ACK_ACCEPTED)) {
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(payload.value, 5'000);
    report("LAUNCH_PHASE_WRITE_FAILED");
    return false;
  }
  // The executable handle denies write/delete sharing from before CreateProcess through this
  // second image-ID check. Hermes uses its configured shared home without profile permission gates.
  std::string preResumeDigest;
  if (metadata.hasHermesLaunchIdentity &&
      (!processImageMatchesTicket(payload.value, ticketExecutable.value) ||
       !ticketPathsStillMatch(metadata, ticketExecutable.value, ticketHermes.value,
         acceptanceEvidence ? &preResumeDigest : nullptr, acceptanceEvidence ? "PRE_RESUME" : nullptr) ||
       (acceptanceEvidence && !addEvidenceRecord(&evidenceRecords, "PRE_RESUME", id, nonce, metadata, preResumeDigest)))) {
    TerminateJobObject(job.value, 1); WaitForSingleObject(payload.value, 5'000);
    report("HERMES_TICKET_OBJECT_MISMATCH"); return false;
  }
  const DWORD previousSuspendCount = ResumeThread(primaryThread.value);
  if (previousSuspendCount == static_cast<DWORD>(-1)) {
    writeLaunchPhase(phaseMapping.value, nonce, RESUME_API_ERROR);
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(payload.value, 5'000);
    report("CHILD_RESUME_API_ERROR");
    return false;
  }
  if (previousSuspendCount == 0) {
    writeLaunchPhase(phaseMapping.value, nonce, RESUME_COUNT_ZERO);
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(payload.value, 5'000);
    report("CHILD_RESUME_COUNT_ZERO");
    return false;
  }
  if (previousSuspendCount > 1) {
    writeLaunchPhase(phaseMapping.value, nonce, RESUME_COUNT_GREATER_THAN_ONE);
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(payload.value, 5'000);
    report("CHILD_RESUME_COUNT_GREATER_THAN_ONE");
    return false;
  }
  if (!writeLaunchPhase(phaseMapping.value, nonce, RESUME_COUNT_ONE)) {
    TerminateJobObject(job.value, 1);
    WaitForSingleObject(payload.value, 5'000);
    report("LAUNCH_PHASE_WRITE_FAILED");
    return false;
  }
  primaryThread.reset();
  childInput.reset(); childOutput.reset(); childError.reset();

  for (;;) {
    if (!queryJobActiveProcessCount(job.value, &active)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
    if (active == 0) break;
    if (!launchControlChannelHealthy()) {
      if (!TerminateJobObject(job.value, 1)) { report("LAUNCH_CONTROL_CHANNEL_LOST"); return false; }
      const ULONGLONG stopDeadline = GetTickCount64() + kStopTimeoutMs;
      do {
        if (!queryJobActiveProcessCount(job.value, &active)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
        if (active == 0) return false;
        Sleep(50);
      } while (GetTickCount64() < stopDeadline);
      report("JOB_STOP_TIMEOUT");
      return false;
    }
    Sleep(100);
  }
  if (acceptanceEvidence) {
    std::string digest;
    if (!launchObjectCommitment("STOPPED_HELD", metadata, &digest) ||
        !addEvidenceRecord(&evidenceRecords, "STOPPED_HELD", id, nonce, metadata, digest) ||
        evidenceRecords.size() != 5) {
      report("HERMES_TICKET_OBJECT_MISMATCH"); return false;
    }
    // The payload Job is already empty. These bounded records are emitted while every pinned
    // source/executable HANDLE remains alive and are never part of the normal launch protocol.
    std::string envelope;
    envelope.reserve(5 * 512 + 32);
    for (const auto& record : evidenceRecords) envelope += record;
    if (envelope.empty() || envelope.size() > 5 * 512) return false;
    char lengthHex[9]{};
    if (sprintf_s(lengthHex, "%08x", static_cast<unsigned int>(envelope.size())) != 8) return false;
    envelope += "EBB_EVIDENCE_END_V3:";
    envelope += lengthHex;
    if (!writeStdout(envelope)) return false;
  }
  DWORD exitCode = 1;
  if (!GetExitCodeProcess(payload.value, &exitCode)) { report("PAYLOAD_EXIT_STATUS_UNAVAILABLE"); return false; }
  *payloadExitCode = exitCode;
  return true;
}

bool inspect(
  const std::wstring& id,
  const std::wstring& nonce,
  const std::wstring& ownerState,
  DWORD helperPid,
  ULONGLONG helperCreation,
  bool hasHelperIdentity,
  bool launchPending,
  bool attemptSettled
) {
  Handle job(OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE, FALSE, jobName(id).c_str()));
  if (!job) {
    const DWORD error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND) return writeStdout("UNKNOWN\tJOB_OPEN_UNAVAILABLE\n");
    if (launchPending) return writeStdout("UNKNOWN\tJOB_ABSENT_LAUNCH_PENDING\n");
    if (ownerState == L"PREPARED") {
      if (attemptSettled && !hasHelperIdentity) return writeStdout("STOPPED\tJOB_ABSENT_ATTEMPT_SETTLED\n");
      return hasHelperIdentity
        ? writeStdout("UNKNOWN\tJOB_ABSENT_PREPARED_HAS_HELPER_IDENTITY\n")
        : writeStdout("STOPPED\tOWNER_NEVER_LAUNCHED\n");
    }
    if (ownerState != L"LAUNCHING" && ownerState != L"LIVE" && ownerState != L"STOPPING" &&
        ownerState != L"STOPPED" && ownerState != L"UNKNOWN") {
      return writeStdout("UNKNOWN\tJOB_ABSENT_OWNER_STATE_UNKNOWN\n");
    }
    if (!hasHelperIdentity) {
      return attemptSettled
        ? writeStdout("STOPPED\tJOB_ABSENT_ATTEMPT_SETTLED\n")
        : writeStdout("UNKNOWN\tJOB_ABSENT_HELPER_IDENTITY_MISSING\n");
    }
    bool helperAbsent = false;
    if (!processInventoryConfirmsHelperAbsent(helperPid, helperCreation, &helperAbsent)) {
      return writeStdout("UNKNOWN\tJOB_ABSENT_HELPER_INVENTORY_UNAVAILABLE\n");
    }
    return helperAbsent
      ? writeStdout("STOPPED\tJOB_ABSENT_NO_HELPER\n")
      : writeStdout("UNKNOWN\tJOB_ABSENT_HELPER_STILL_LIVE\n");
  }

  Handle mapping(OpenFileMappingW(FILE_MAP_READ, FALSE, mappingName(id).c_str()));
  Identity identity{};
  if (!mapping || !readMapping(mapping.value, nonce, &identity)) {
    return writeStdout("UNKNOWN\tMAPPING_OR_IDENTITY_UNAVAILABLE\n");
  }
  DWORD active = 0;
  if (!queryJobActiveProcessCount(job.value, &active)) return writeStdout("UNKNOWN\tJOB_ACCOUNTING_UNAVAILABLE\n");
  if (active == 0) { writeStdout("STOPPED\tJOB_EMPTY\n"); return true; }
  if (!printIdentity("LIVE", id, nonce, identity)) { report("IDENTITY_OUTPUT_FAILED"); return false; }
  return true;
}

bool stop(const std::wstring& id, const std::wstring& nonce) {
  Handle job, mapping;
  Identity identity{};
  if (!openOwnerObjects(id, nonce, &job, &mapping, &identity)) { report("JOB_OR_IDENTITY_UNAVAILABLE"); return false; }
  DWORD active = 0;
  if (!queryJobActiveProcessCount(job.value, &active)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
  if (active == 0) { writeStdout("STOPPED\tJOB_EMPTY\n"); return true; }
  if (!TerminateJobObject(job.value, 1)) { report("JOB_TERMINATE_FAILED"); return false; }
  const ULONGLONG deadline = GetTickCount64() + kStopTimeoutMs;
  do {
    if (!queryJobActiveProcessCount(job.value, &active)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
    if (active == 0) { writeStdout("STOPPED\tJOB_EMPTY\n"); return true; }
    Sleep(50);
  } while (GetTickCount64() < deadline);
  report("JOB_STOP_TIMEOUT");
  return false;
}

int run(int argc, wchar_t** argv) {
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 || argc < 2) { report("ARGUMENTS_INVALID"); return 2; }
  const std::wstring operation(argv[1]);
#ifdef EBB_ENABLE_NATIVE_FRAME_ACCEPTANCE
  if (operation == L"verify-host-image-opens" && argc == 5 && isLowerHex(argv[3], 16) && isLowerHex(argv[4], 32)) {
    LaunchMetadata metadata;
    metadata.executable = argv[2];
    metadata.hermesExecutable = argv[2];
    metadata.executableVolumeSerial = metadata.hermesVolumeSerial = argv[3];
    metadata.executableFileId = metadata.hermesFileId = argv[4];
    Handle executable, launcher;
    if (!openTicketExecutable(metadata, &executable) || !openTicketHermesLauncher(metadata, &launcher)) {
      report("TEST_HOST_IMAGE_ACCESS_REJECTED"); return 2;
    }
    return writeStdout("HOST_IMAGES_VERIFIED\n") ? 0 : 4;
  }
  if (operation == L"validate-frame" && argc == 3 && isHexId(argv[2])) {
    LaunchMetadata metadata;
    if (!readMetadata(&metadata) || !metadata.hasHermesLaunchIdentity) {
      report("LAUNCH_FRAME_INVALID");
      return 2;
    }
    if (!readLaunchAcknowledgement(argv[2])) {
      report("LAUNCH_ACK_REJECTED");
      return 3;
    }
    return writeStdout("FRAME_VALID\n") ? 0 : 4;
  }
#endif
  if ((operation == L"launch" || operation == L"launch-evidence") && argc == 4 && isHexId(argv[2]) && isHexId(argv[3])) {
    DWORD payloadExitCode = 0;
    if (!launch(argv[2], argv[3], &payloadExitCode, operation == L"launch-evidence")) return 3;
    return static_cast<int>(payloadExitCode);
  }
  if (operation == L"inspect" && argc == 9 && isHexId(argv[2]) && isHexId(argv[3]) && isOwnerState(argv[4])) {
    DWORD helperPid = 0;
    ULONGLONG helperCreation = 0;
    bool hasHelperIdentity = false;
    const std::wstring pendingText(argv[7]);
    const bool launchPending = pendingText == L"1";
    const std::wstring attemptSettledText(argv[8]);
    const bool attemptSettled = attemptSettledText == L"1";
    if (!parseHelperIdentity(argv[5], argv[6], &helperPid, &helperCreation, &hasHelperIdentity)) {
      report("ARGUMENTS_INVALID");
      return 2;
    }
    if ((pendingText != L"0" && pendingText != L"1") ||
        (attemptSettledText != L"0" && attemptSettledText != L"1") || (launchPending && attemptSettled)) {
      report("ARGUMENTS_INVALID"); return 2;
    }
    return inspect(argv[2], argv[3], argv[4], helperPid, helperCreation, hasHelperIdentity,
      launchPending, attemptSettled) ? 0 : 4;
  }
  if (operation == L"phase" && argc == 4 && isHexId(argv[2]) && isHexId(argv[3])) {
    return inspectLaunchPhase(argv[2], argv[3]) ? 0 : 4;
  }
  if (operation == L"stop" && argc == 4 && isHexId(argv[2]) && isHexId(argv[3])) return stop(argv[2], argv[3]) ? 0 : 5;
  report("ARGUMENTS_INVALID");
  return 2;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  const int result = run(argc, argv);
  return result;
}
