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
#include <winternl.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <aclapi.h>
#include <sddl.h>
#include <io.h>
#include <fcntl.h>
#include "../hermes-profile-path/hermes-profile-path-acl-policy.h"
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
constexpr DWORD kMaxProfilePathComponents = 64;
constexpr DWORD kMaxSnapshotProjectionBytes = 64 * 1024 * 1024;
constexpr DWORD kMaxSnapshotEntries = 100'000;
constexpr DWORD kMaxSnapshotFileBytes = 256 * 1024 * 1024;
constexpr ULONGLONG kMaxSnapshotTotalBytes = 1024ull * 1024ull * 1024ull;
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
  std::wstring profileHome;
  std::wstring hermesExecutable;
  std::wstring hermesVolumeSerial;
  std::wstring hermesFileId;
  std::wstring executableVolumeSerial;
  std::wstring executableFileId;
  std::wstring profileVolumeSerial;
  std::wstring profileFileId;
  std::wstring profileHomeDirectoryVolumeSerial;
  std::wstring profileHomeDirectoryFileId;
  std::wstring profileConfigVolumeSerial;
  std::wstring profileConfigFileId;
  std::wstring runId;
  DWORD profileChainVersion = 0;
  DWORD authRootIndex = 0;
  std::vector<std::pair<std::wstring, std::wstring>> profilePathChain;
  std::wstring hermesSourceSnapshotKey;
  std::wstring hermesSourceSnapshotRoot;
  std::wstring snapshotVolumeSerial;
  std::wstring snapshotFileId;
  std::wstring hermesSourceManifestDigest;
  std::wstring hermesSourceProjectionPath;
  std::wstring hermesSourceProjectionSha256;
  DWORD hermesSourceProjectionSize = 0;
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

bool readExactHandle(HANDLE file, void* buffer, DWORD size) {
  auto* bytes = static_cast<unsigned char*>(buffer);
  DWORD offset = 0;
  while (offset < size) {
    DWORD read = 0;
    if (!ReadFile(file, bytes + offset, size - offset, &read, nullptr) || read == 0) return false;
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

bool sha256File(HANDLE file, ULONGLONG expectedSize, unsigned char digest[32]) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD objectBytes = 0, returned = 0;
  std::vector<unsigned char> object;
  bool ok = BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0)) &&
    BCRYPT_SUCCESS(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectBytes), sizeof(objectBytes), &returned, 0));
  if (ok && objectBytes > 0) object.resize(objectBytes);
  ok = ok && !object.empty() && BCRYPT_SUCCESS(BCryptCreateHash(algorithm, &hash, object.data(), objectBytes, nullptr, 0, 0));
  std::vector<unsigned char> buffer(64 * 1024);
  ULONGLONG total = 0;
  while (ok) {
    DWORD read = 0;
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) { ok = false; break; }
    if (read == 0) break;
    total += read;
    if (total > expectedSize || !BCRYPT_SUCCESS(BCryptHashData(hash, buffer.data(), read, 0))) { ok = false; break; }
  }
  ok = ok && total == expectedSize && BCRYPT_SUCCESS(BCryptFinishHash(hash, digest, 32, 0));
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!object.empty()) SecureZeroMemory(object.data(), object.size());
  if (!buffer.empty()) SecureZeroMemory(buffer.data(), buffer.size());
  return ok;
}

std::wstring bytesToHex(const unsigned char* bytes, size_t length) {
  static constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring result;
  result.reserve(length * 2);
  for (size_t index = 0; index < length; ++index) {
    result.push_back(hex[(bytes[index] >> 4) & 0x0f]);
    result.push_back(hex[bytes[index] & 0x0f]);
  }
  return result;
}

bool validPrivateAcl(HANDLE handle) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD securityStatus = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &descriptor);
  if (securityStatus != ERROR_SUCCESS || !owner || !dacl || !descriptor) {
    if (descriptor) LocalFree(descriptor);
    return false;
  }
  HANDLE token = nullptr;
  DWORD tokenBytes = 0;
  GetTokenInformation(GetCurrentProcessToken(), TokenUser, nullptr, 0, &tokenBytes);
  std::vector<unsigned char> tokenBuffer(tokenBytes);
  bool valid = tokenBytes > 0 && GetTokenInformation(GetCurrentProcessToken(), TokenUser, tokenBuffer.data(), tokenBytes, &tokenBytes);
  PSID currentUser = valid ? reinterpret_cast<TOKEN_USER*>(tokenBuffer.data())->User.Sid : nullptr;
  SID_IDENTIFIER_AUTHORITY ntAuthority = SECURITY_NT_AUTHORITY;
  PSID localSystem = nullptr;
  if (!AllocateAndInitializeSid(&ntAuthority, 1, SECURITY_LOCAL_SYSTEM_RID, 0, 0, 0, 0, 0, 0, 0, &localSystem)) valid = false;
  valid = valid && currentUser && EqualSid(owner, currentUser);
  if (valid) {
    for (DWORD index = 0; index < dacl->AceCount; ++index) {
      void* rawAce = nullptr;
      if (!GetAce(dacl, index, &rawAce) || !rawAce) { valid = false; break; }
      const auto* header = static_cast<ACE_HEADER*>(rawAce);
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        PSID sid = const_cast<DWORD*>(&ace->SidStart);
        if (!EqualSid(sid, currentUser) && !(localSystem && EqualSid(sid, localSystem))) { valid = false; break; }
      } else if (header->AceType != ACCESS_DENIED_ACE_TYPE) {
        valid = false;
        break;
      }
    }
  }
  if (localSystem) FreeSid(localSystem);
  if (token) CloseHandle(token);
  if (descriptor) LocalFree(descriptor);
  return valid;
}

struct SnapshotEntry {
  std::wstring path;
  std::string pathUtf8;
  unsigned char mode = 0;
  unsigned char digest[32]{};
  bool seen = false;
};

bool readLe16(const std::vector<unsigned char>& bytes, size_t* offset, unsigned short* value) {
  if (*offset > bytes.size() || bytes.size() - *offset < 2) return false;
  *value = static_cast<unsigned short>(bytes[*offset]) |
    static_cast<unsigned short>(static_cast<unsigned short>(bytes[*offset + 1]) << 8);
  *offset += 2;
  return true;
}

bool readLe32(const std::vector<unsigned char>& bytes, size_t* offset, DWORD* value) {
  if (*offset > bytes.size() || bytes.size() - *offset < 4) return false;
  *value = static_cast<DWORD>(bytes[*offset]) |
    (static_cast<DWORD>(bytes[*offset + 1]) << 8) |
    (static_cast<DWORD>(bytes[*offset + 2]) << 16) |
    (static_cast<DWORD>(bytes[*offset + 3]) << 24);
  *offset += 4;
  return true;
}

bool decodeSnapshotPath(const std::string& utf8, std::wstring* wide) {
  if (utf8.empty() || utf8.size() > 240 || utf8.find('\0') != std::string::npos || utf8.front() == '/' || utf8.back() == '/') return false;
  const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  if (required <= 0) return false;
  wide->resize(static_cast<size_t>(required));
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), wide->data(), required)) return false;
  const int encodedBytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide->data(), required, nullptr, 0, nullptr, nullptr);
  if (encodedBytes != static_cast<int>(utf8.size())) return false;
  std::string encoded(static_cast<size_t>(encodedBytes), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide->data(), required, encoded.data(), encodedBytes, nullptr, nullptr) || encoded != utf8) return false;
  if (wide->find(L'\\') != std::wstring::npos || wide->find(L':') != std::wstring::npos) return false;
  for (wchar_t character : *wide) {
    if (character < 0x20 || character == L'<' || character == L'>' || character == L'"' ||
        character == L'|' || character == L'?' || character == L'*') return false;
  }
  size_t start = 0;
  while (start <= wide->size()) {
    const size_t end = wide->find(L'/', start);
    const std::wstring part = wide->substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    const size_t dot = part.find(L'.');
    std::wstring stem = part.substr(0, dot);
    for (auto& character : stem) character = static_cast<wchar_t>(towupper(character));
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
        (stem.size() == 4 && (stem.compare(0, 3, L"COM") == 0 || stem.compare(0, 3, L"LPT") == 0) && stem[3] >= L'1' && stem[3] <= L'9')) return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return true;
}

bool sameDigestHex(const unsigned char digest[32], const std::wstring& expected) {
  return expected.size() == 64 && bytesToHex(digest, 32) == expected;
}

bool ticketFileIdentity(HANDLE handle, const std::wstring& expectedVolume, const std::wstring& expectedFileId);

bool readProjection(const LaunchMetadata& metadata, std::vector<SnapshotEntry>* entries,
                    std::vector<Handle>* heldHandles) {
  Handle projection(CreateFileW(metadata.hermesSourceProjectionPath.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!projection) return false;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  BY_HANDLE_FILE_INFORMATION details{};
  LARGE_INTEGER fileSize{};
  if (!GetFileInformationByHandleEx(projection.value, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !GetFileInformationByHandle(projection.value, &details) || details.nNumberOfLinks != 1 ||
      !GetFileSizeEx(projection.value, &fileSize) || fileSize.QuadPart != metadata.hermesSourceProjectionSize ||
      !validPrivateAcl(projection.value)) return false;
  std::vector<unsigned char> bytes(static_cast<size_t>(metadata.hermesSourceProjectionSize));
  if (!readExactHandle(projection.value, bytes.data(), static_cast<DWORD>(bytes.size()))) return false;
  unsigned char projectionDigest[32]{};
  if (!sha256Buffer(bytes.data(), static_cast<DWORD>(bytes.size()), projectionDigest) ||
      !sameDigestHex(projectionDigest, metadata.hermesSourceProjectionSha256) || bytes.size() < 80 ||
      std::memcmp(bytes.data(), "EHSP", 4) != 0 || bytes[4] != 1 || bytes[5] != 0 || bytes[6] != 0 || bytes[7] != 0) return false;
  size_t offset = 8;
  DWORD keyLength = 0;
  if (!readLe32(bytes, &offset, &keyLength) || keyLength == 0 || keyLength > 4096 || bytes.size() - offset < 64) return false;
  const unsigned char* directoryIdBytes = bytes.data() + offset;
  const unsigned char* manifestDigestBytes = bytes.data() + offset + 32;
  offset += 64;
  if (bytes.size() - offset < keyLength) return false;
  const std::string key(reinterpret_cast<const char*>(bytes.data() + offset), keyLength);
  const int keyChars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, key.data(), static_cast<int>(key.size()), nullptr, 0);
  if (keyChars <= 0) return false;
  std::wstring keyWide(static_cast<size_t>(keyChars), L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, key.data(), static_cast<int>(key.size()), keyWide.data(), keyChars) ||
      keyWide != metadata.hermesSourceSnapshotKey) return false;
  unsigned char keyDigest[32]{};
  if (!sha256Buffer(reinterpret_cast<const unsigned char*>(key.data()), static_cast<DWORD>(key.size()), keyDigest) ||
      std::memcmp(keyDigest, directoryIdBytes, 32) != 0 ||
      !sameDigestHex(manifestDigestBytes, metadata.hermesSourceManifestDigest)) return false;
  offset += keyLength;
  DWORD count = 0;
  if (!readLe32(bytes, &offset, &count) || count == 0 || count > kMaxSnapshotEntries) return false;
  entries->reserve(count);
  std::map<std::wstring, size_t, CaseInsensitiveLess> folded;
  std::string previous;
  for (DWORD index = 0; index < count; ++index) {
    unsigned short pathLength = 0;
    if (!readLe16(bytes, &offset, &pathLength) || pathLength == 0 || pathLength > 960 || bytes.size() - offset < 1 + pathLength + 32) return false;
    SnapshotEntry entry;
    entry.mode = bytes[offset++];
    if (entry.mode > 1) return false;
    entry.pathUtf8.assign(reinterpret_cast<const char*>(bytes.data() + offset), pathLength);
    offset += pathLength;
    if (!previous.empty() && !std::lexicographical_compare(previous.begin(), previous.end(), entry.pathUtf8.begin(), entry.pathUtf8.end(),
        [](char left, char right) { return static_cast<unsigned char>(left) < static_cast<unsigned char>(right); })) return false;
    previous = entry.pathUtf8;
    if (!decodeSnapshotPath(entry.pathUtf8, &entry.path) || !folded.emplace(entry.path, entries->size()).second) return false;
    std::memcpy(entry.digest, bytes.data() + offset, 32);
    offset += 32;
    entries->push_back(std::move(entry));
  }
  SecureZeroMemory(bytes.data(), bytes.size());
  if (offset != metadata.hermesSourceProjectionSize) return false;
  heldHandles->push_back(std::move(projection));
  return true;
}

bool openSnapshotDirectory(const std::wstring& path, bool exclusive, bool requirePrivateAcl, Handle* handle) {
  const DWORD share = exclusive ? FILE_SHARE_READ : (FILE_SHARE_READ | FILE_SHARE_WRITE);
  handle->reset(CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
    share, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!*handle) return false;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return GetFileInformationByHandleEx(handle->value, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
    (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
    (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
    (!requirePrivateAcl || validPrivateAcl(handle->value));
}

bool openSnapshotRootChain(const LaunchMetadata& metadata, std::vector<Handle>* handles) {
  const std::wstring& pathname = metadata.hermesSourceSnapshotRoot;
  const int keyBytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, metadata.hermesSourceSnapshotKey.data(),
    static_cast<int>(metadata.hermesSourceSnapshotKey.size()), nullptr, 0, nullptr, nullptr);
  if (keyBytes <= 0) return false;
  std::string key(static_cast<size_t>(keyBytes), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, metadata.hermesSourceSnapshotKey.data(),
      static_cast<int>(metadata.hermesSourceSnapshotKey.size()), key.data(), keyBytes, nullptr, nullptr)) return false;
  unsigned char keyDigest[32]{};
  if (!sha256Buffer(reinterpret_cast<const unsigned char*>(key.data()), static_cast<DWORD>(key.size()), keyDigest)) return false;
  const std::wstring directoryId = bytesToHex(keyDigest, 32);
  const size_t rootSeparator = pathname.find_last_of(L'\\');
  if (rootSeparator == std::wstring::npos || pathname.substr(rootSeparator + 1) != directoryId) return false;
  const std::wstring expectedProjection = pathname.substr(0, rootSeparator + 1) + directoryId + L".native-v1.bin";
  if (_wcsicmp(expectedProjection.c_str(), metadata.hermesSourceProjectionPath.c_str()) != 0) return false;
  size_t componentOffset = 0;
  std::wstring current;
  if (pathname.size() >= 7 && pathname.compare(0, 4, L"\\\\?\\") == 0 &&
      ((pathname[4] >= L'A' && pathname[4] <= L'Z') || (pathname[4] >= L'a' && pathname[4] <= L'z')) &&
      pathname[5] == L':' && pathname[6] == L'\\') {
    current = pathname.substr(0, 7);
    componentOffset = 7;
  } else if (pathname.size() >= 3 &&
             ((pathname[0] >= L'A' && pathname[0] <= L'Z') || (pathname[0] >= L'a' && pathname[0] <= L'z')) &&
             pathname[1] == L':' && pathname[2] == L'\\') {
    current = pathname.substr(0, 3);
    componentOffset = 3;
  } else {
    return false;
  }
  while (componentOffset < pathname.size()) {
    while (componentOffset < pathname.size() && pathname[componentOffset] == L'\\') ++componentOffset;
    if (componentOffset >= pathname.size()) break;
    const size_t separator = pathname.find(L'\\', componentOffset);
    const size_t end = separator == std::wstring::npos ? pathname.size() : separator;
    const std::wstring component = pathname.substr(componentOffset, end - componentOffset);
    if (component.empty() || component == L"." || component == L"..") return false;
    if (current.back() != L'\\') current.push_back(L'\\');
    current += component;
    Handle directory;
    const bool finalComponent = end == std::wstring::npos;
    if (!openSnapshotDirectory(current, finalComponent, finalComponent, &directory)) return false;
    if (finalComponent && !ticketFileIdentity(directory.value, metadata.snapshotVolumeSerial, metadata.snapshotFileId)) return false;
    handles->push_back(std::move(directory));
    componentOffset = end;
  }
  return handles->size() > 0;
}

void setSnapshotTreeFailureStage(const char** failureStage, const char* stage) {
  if (failureStage && *failureStage == nullptr) *failureStage = stage;
}

void reportSnapshotTreeFailure(const char* code, const char* stage) {
  static constexpr const char* allowed[] = {
    "PATH_ENUMERATION", "ENTRY_SHAPE", "FILE_ATTRIBUTES", "FILE_OPEN", "FILE_LINK_COUNT",
    "FILE_SIZE", "FILE_DACL", "CONTENT_HASH", "CONTENT_MISMATCH", "ENUMERATION_END",
    "ENUMERATION_COMPLETENESS", "PROJECTION_ENTRY_COLLISION",
  };
  if (!code || std::strcmp(code, "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH") != 0) {
    report(code ? code : "LAUNCH_TICKET_SOURCE_SNAPSHOT_MISMATCH");
    return;
  }
  for (const char* candidate : allowed) {
    if (stage && std::strcmp(stage, candidate) == 0) {
      writeStdout(std::string("UNKNOWN\t") + code + "\t" + candidate + "\n");
      return;
    }
  }
  report(code);
}

bool verifySnapshotDirectory(const std::wstring& absolute, const std::wstring& relative,
  const std::map<std::wstring, SnapshotEntry*, CaseInsensitiveLess>& expectedFiles,
  const std::map<std::wstring, bool, CaseInsensitiveLess>& expectedDirectories,
  std::map<std::wstring, bool, CaseInsensitiveLess>* seenFiles,
  std::map<std::wstring, bool, CaseInsensitiveLess>* seenDirectories,
  std::vector<Handle>* handles, ULONGLONG* totalBytes, const char** failureStage) {
  WIN32_FIND_DATAW data{};
  const std::wstring pattern = absolute + L"\\*";
  HANDLE search = FindFirstFileW(pattern.c_str(), &data);
  if (search == INVALID_HANDLE_VALUE) {
    setSnapshotTreeFailureStage(failureStage, "PATH_ENUMERATION");
    return false;
  }
  bool valid = true;
  do {
    const std::wstring name(data.cFileName);
    if (name == L"." || name == L"..") continue;
    if (name.empty() || name.find_first_of(L"/\\<>:\"|?*") != std::wstring::npos ||
        name.back() == L'.' || name.back() == L' ' || (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      setSnapshotTreeFailureStage(failureStage, "ENTRY_SHAPE");
      valid = false;
      break;
    }
    const std::wstring path = relative.empty() ? name : relative + L"/" + name;
    const std::wstring childPath = absolute + L"\\" + name;
    if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      if (expectedDirectories.find(path) == expectedDirectories.end() || !seenDirectories->emplace(path, true).second) {
        setSnapshotTreeFailureStage(failureStage, "PATH_ENUMERATION");
        valid = false;
        break;
      }
      Handle directory;
      if (!openSnapshotDirectory(childPath, true, true, &directory)) {
        setSnapshotTreeFailureStage(failureStage, "PATH_ENUMERATION");
        valid = false;
        break;
      }
      handles->push_back(std::move(directory));
      if (!verifySnapshotDirectory(childPath, path, expectedFiles, expectedDirectories,
          seenFiles, seenDirectories, handles, totalBytes, failureStage)) { valid = false; break; }
    } else {
      const auto expected = expectedFiles.find(path);
      if ((data.dwFileAttributes & FILE_ATTRIBUTE_NORMAL) == 0 &&
          (data.dwFileAttributes & FILE_ATTRIBUTE_READONLY) == 0) {
        setSnapshotTreeFailureStage(failureStage, "FILE_ATTRIBUTES");
        valid = false;
        break;
      }
      if (expected == expectedFiles.end() || !seenFiles->emplace(path, true).second) {
        setSnapshotTreeFailureStage(failureStage, "PATH_ENUMERATION");
        valid = false;
        break;
      }
      if ((data.dwFileAttributes & FILE_ATTRIBUTE_READONLY) == 0) {
        setSnapshotTreeFailureStage(failureStage, "FILE_ATTRIBUTES");
        valid = false;
        break;
      }
      Handle file(CreateFileW(childPath.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
      if (!file) {
        setSnapshotTreeFailureStage(failureStage, "FILE_OPEN");
        valid = false;
        break;
      }
      FILE_ATTRIBUTE_TAG_INFO attributes{};
      BY_HANDLE_FILE_INFORMATION details{};
      LARGE_INTEGER size{};
      if (!GetFileInformationByHandleEx(file.value, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
          (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_READONLY)) != FILE_ATTRIBUTE_READONLY ||
          !GetFileInformationByHandle(file.value, &details)) {
        setSnapshotTreeFailureStage(failureStage, "FILE_ATTRIBUTES");
        valid = false;
        break;
      }
      if (details.nNumberOfLinks != 1) {
        setSnapshotTreeFailureStage(failureStage, "FILE_LINK_COUNT");
        valid = false;
        break;
      }
      if (!GetFileSizeEx(file.value, &size) || size.QuadPart < 0 ||
          static_cast<ULONGLONG>(size.QuadPart) > kMaxSnapshotFileBytes ||
          *totalBytes > kMaxSnapshotTotalBytes - static_cast<ULONGLONG>(size.QuadPart)) {
        setSnapshotTreeFailureStage(failureStage, "FILE_SIZE");
        valid = false;
        break;
      }
      if (!validPrivateAcl(file.value)) {
        setSnapshotTreeFailureStage(failureStage, "FILE_DACL");
        valid = false;
        break;
      }
      unsigned char digest[32]{};
      if (!sha256File(file.value, static_cast<ULONGLONG>(size.QuadPart), digest)) {
        setSnapshotTreeFailureStage(failureStage, "CONTENT_HASH");
        valid = false;
        break;
      }
      if (std::memcmp(digest, expected->second->digest, 32) != 0) {
        setSnapshotTreeFailureStage(failureStage, "CONTENT_MISMATCH");
        valid = false;
        break;
      }
      *totalBytes += static_cast<ULONGLONG>(size.QuadPart);
      expected->second->seen = true;
      handles->push_back(std::move(file));
    }
  } while (FindNextFileW(search, &data));
  const DWORD findError = GetLastError();
  FindClose(search);
  if (findError != ERROR_NO_MORE_FILES) setSnapshotTreeFailureStage(failureStage, "ENUMERATION_END");
  return valid && findError == ERROR_NO_MORE_FILES;
}

bool verifyHermesSourceSnapshot(const LaunchMetadata& metadata, std::vector<Handle>* heldHandles,
                               const char** failureCode = nullptr, const char** failureStage = nullptr) {
  const char* localFailureStage = nullptr;
  const char** diagnosticStage = failureStage ? failureStage : &localFailureStage;
  const auto fail = [failureCode](const char* code) {
    if (failureCode) *failureCode = code;
    return false;
  };
  std::vector<Handle> currentHandles;
  if (!openSnapshotRootChain(metadata, &currentHandles)) return fail("LAUNCH_TICKET_SOURCE_SNAPSHOT_ROOT_UNSAFE");
  std::vector<SnapshotEntry> entries;
  if (!readProjection(metadata, &entries, &currentHandles)) return fail("LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE");
  std::map<std::wstring, SnapshotEntry*, CaseInsensitiveLess> expectedFiles;
  std::map<std::wstring, bool, CaseInsensitiveLess> expectedDirectories;
  for (SnapshotEntry& entry : entries) {
    if (!expectedFiles.emplace(entry.path, &entry).second) {
      setSnapshotTreeFailureStage(diagnosticStage, "PROJECTION_ENTRY_COLLISION");
      return fail("LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH");
    }
    size_t separator = entry.path.find(L'/');
    while (separator != std::wstring::npos) {
      if (!expectedDirectories.emplace(entry.path.substr(0, separator), true).second) {
        // An existing parent is expected; map insertion is intentionally idempotent.
      }
      separator = entry.path.find(L'/', separator + 1);
    }
  }
  std::map<std::wstring, bool, CaseInsensitiveLess> seenFiles;
  std::map<std::wstring, bool, CaseInsensitiveLess> seenDirectories;
  ULONGLONG totalBytes = 0;
  const bool treeValid = verifySnapshotDirectory(metadata.hermesSourceSnapshotRoot, L"", expectedFiles, expectedDirectories,
      &seenFiles, &seenDirectories, &currentHandles, &totalBytes, diagnosticStage);
  if (!treeValid ||
      seenFiles.size() != expectedFiles.size() || seenDirectories.size() != expectedDirectories.size()) {
    if (*diagnosticStage == nullptr) setSnapshotTreeFailureStage(diagnosticStage, "ENUMERATION_COMPLETENESS");
    return fail("LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH");
  }
  for (const SnapshotEntry& entry : entries) {
    if (!entry.seen) {
      setSnapshotTreeFailureStage(diagnosticStage, "ENUMERATION_COMPLETENESS");
      return fail("LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH");
    }
  }
  if (heldHandles) {
    for (Handle& handle : currentHandles) heldHandles->push_back(std::move(handle));
  }
  return true;
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
    L"HOME", L"HERMES_HOME", L"HERMES_CONFIG", L"HERMES_MODEL"
  };
  if (name.empty() || !((name[0] >= L'A' && name[0] <= L'Z') || name[0] == L'_')) return false;
  for (wchar_t c : name) if (!((c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'_')) return false;
  for (const auto* candidate : allowed) if (name == candidate) return true;
  return false;
}

bool readMetadata(LaunchMetadata* metadata) {
  DWORD magic = 0, frameByteLength = 0, argCount = 0, envCount = 0;
  if (!readU32(&magic) || magic != 0x45424233 || !readU32(&frameByteLength) ||
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
  if (metadata->hasHermesLaunchIdentity) {
    if (!readString(&metadata->profileHome, &remaining) ||
        !readString(&metadata->hermesExecutable, &remaining) ||
        !readString(&metadata->hermesVolumeSerial, &remaining) ||
        !readString(&metadata->hermesFileId, &remaining) ||
        !readString(&metadata->executableVolumeSerial, &remaining) ||
        !readString(&metadata->executableFileId, &remaining) ||
        !readString(&metadata->profileVolumeSerial, &remaining) ||
        !readString(&metadata->profileFileId, &remaining) ||
        !readString(&metadata->profileHomeDirectoryVolumeSerial, &remaining) ||
        !readString(&metadata->profileHomeDirectoryFileId, &remaining) ||
        !readString(&metadata->profileConfigVolumeSerial, &remaining) ||
        !readString(&metadata->profileConfigFileId, &remaining) ||
        !readString(&metadata->runId, &remaining) ||
        !readFrameU32(&metadata->profileChainVersion, &remaining) ||
        !readFrameU32(&metadata->authRootIndex, &remaining)) return false;
    DWORD profilePathChainCount = 0;
    if (!readFrameU32(&profilePathChainCount, &remaining) || profilePathChainCount < 4 ||
        profilePathChainCount > kMaxProfilePathComponents || metadata->profileChainVersion != 1 ||
        metadata->authRootIndex == 0 || metadata->authRootIndex + 3 != profilePathChainCount) return false;
    metadata->profilePathChain.reserve(profilePathChainCount);
    for (DWORD index = 0; index < profilePathChainCount; ++index) {
      std::wstring volumeSerial, fileId;
      if (!readString(&volumeSerial, &remaining) || !readString(&fileId, &remaining) ||
          !isLowerHex(volumeSerial, 16) || !isLowerHex(fileId, 32) ||
          (index != 0 && volumeSerial != metadata->profilePathChain.front().first)) return false;
      metadata->profilePathChain.emplace_back(std::move(volumeSerial), std::move(fileId));
    }
    if (!readString(&metadata->hermesSourceSnapshotKey, &remaining) ||
        !readString(&metadata->hermesSourceSnapshotRoot, &remaining) ||
        !readString(&metadata->snapshotVolumeSerial, &remaining) ||
        !readString(&metadata->snapshotFileId, &remaining) ||
        !readString(&metadata->hermesSourceManifestDigest, &remaining) ||
        !readString(&metadata->hermesSourceProjectionPath, &remaining) ||
        !readString(&metadata->hermesSourceProjectionSha256, &remaining) ||
        !readFrameU32(&metadata->hermesSourceProjectionSize, &remaining) ||
        metadata->profileHome.empty() || metadata->hermesExecutable.empty() || metadata->hermesVolumeSerial.size() != 16 ||
        metadata->hermesFileId.size() != 32 || metadata->executableVolumeSerial.size() != 16 ||
        metadata->executableFileId.size() != 32 || metadata->profileVolumeSerial.size() != 16 ||
        metadata->profileFileId.size() != 32 || metadata->profileHomeDirectoryVolumeSerial.size() != 16 ||
        metadata->profileHomeDirectoryFileId.size() != 32 || metadata->profileConfigVolumeSerial.size() != 16 ||
        metadata->profileConfigFileId.size() != 32 || metadata->hermesSourceSnapshotKey.empty() ||
        metadata->hermesSourceSnapshotKey.size() > 4096 || metadata->hermesSourceSnapshotRoot.empty() ||
        metadata->snapshotVolumeSerial.size() != 16 || metadata->snapshotFileId.size() != 32 ||
        metadata->hermesSourceManifestDigest.size() != 64 || metadata->hermesSourceProjectionPath.empty() ||
        metadata->hermesSourceProjectionSha256.size() != 64 || metadata->hermesSourceProjectionSize < 76 ||
        metadata->hermesSourceProjectionSize > kMaxSnapshotProjectionBytes ||
        metadata->profilePathChain.back().first != metadata->profileVolumeSerial ||
        metadata->profilePathChain.back().second != metadata->profileFileId ||
        metadata->runId.size() != 36 || metadata->runId[8] != L'-' || metadata->runId[13] != L'-' ||
        metadata->runId[18] != L'-' || metadata->runId[23] != L'-' || metadata->runId[14] != L'4' ||
        (metadata->runId[19] != L'8' && metadata->runId[19] != L'9' && metadata->runId[19] != L'a' && metadata->runId[19] != L'b')) return false;
    for (size_t index = 0; index < metadata->runId.size(); ++index) {
      if (index == 8 || index == 13 || index == 18 || index == 23) continue;
      const wchar_t c = metadata->runId[index];
      if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
    }
    for (const auto* value : {&metadata->hermesVolumeSerial, &metadata->hermesFileId,
                              &metadata->executableVolumeSerial, &metadata->executableFileId,
                              &metadata->profileVolumeSerial, &metadata->profileFileId,
                              &metadata->profileHomeDirectoryVolumeSerial, &metadata->profileHomeDirectoryFileId,
                              &metadata->profileConfigVolumeSerial, &metadata->profileConfigFileId,
                              &metadata->snapshotVolumeSerial, &metadata->snapshotFileId,
                              &metadata->hermesSourceManifestDigest, &metadata->hermesSourceProjectionSha256}) {
      const size_t expectedLength = (value == &metadata->hermesVolumeSerial || value == &metadata->executableVolumeSerial ||
        value == &metadata->profileVolumeSerial || value == &metadata->profileHomeDirectoryVolumeSerial ||
        value == &metadata->profileConfigVolumeSerial || value == &metadata->snapshotVolumeSerial) ? 16 :
        (value == &metadata->hermesSourceManifestDigest || value == &metadata->hermesSourceProjectionSha256) ? 64 : 32;
      if (!isLowerHex(*value, expectedLength)) return false;
    }
    const auto hermesHome = metadata->environment.find(L"HERMES_HOME");
    const auto home = metadata->environment.find(L"HOME");
    const auto config = metadata->environment.find(L"HERMES_CONFIG");
    if (hermesHome == metadata->environment.end() || home == metadata->environment.end() ||
        config == metadata->environment.end() || hermesHome->second != metadata->profileHome ||
        home->second != metadata->profileHome + L"\\home" ||
        config->second != metadata->profileHome + L"\\config.yaml" ||
        metadata->profileHomeDirectoryVolumeSerial != metadata->profileVolumeSerial ||
        metadata->profileConfigVolumeSerial != metadata->profileVolumeSerial) return false;
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

bool handleIdentity(HANDLE handle, std::pair<std::wstring, std::wstring>* identity) {
  FILE_ID_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info))) return false;
  wchar_t volume[17]{};
  swprintf_s(volume, L"%016llx", static_cast<unsigned long long>(info.VolumeSerialNumber));
  static constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring fileId;
  fileId.reserve(sizeof(info.FileId.Identifier) * 2);
  for (const unsigned char byte : info.FileId.Identifier) {
    fileId.push_back(hex[(byte >> 4) & 0x0f]);
    fileId.push_back(hex[byte & 0x0f]);
  }
  *identity = {volume, std::move(fileId)};
  return true;
}

bool pathChainCommitment(const char* stage, const LaunchMetadata& metadata,
                         const std::vector<std::pair<std::wstring, std::wstring>>& components,
                         const std::pair<std::wstring, std::wstring>& home,
                         const std::pair<std::wstring, std::wstring>& config,
                         std::string* digestHex) {
  std::string runId;
  if (!toAscii(metadata.runId, &runId) || components.size() != metadata.profilePathChain.size()) return false;
  std::string canonical = std::string("EBB-PATH-CHAIN-EVIDENCE-V1\n") + stage + "\n" + runId + "\nchain-v" +
    std::to_string(metadata.profileChainVersion) + "\ncomponent-count=" + std::to_string(components.size()) + "\n";
  for (const auto& component : components) {
    std::string volume, file;
    if (!toAscii(component.first, &volume) || !toAscii(component.second, &file)) return false;
    canonical += volume + ":" + file + "\n";
  }
  std::string homeVolume, homeFile, configVolume, configFile;
  if (!toAscii(home.first, &homeVolume) || !toAscii(home.second, &homeFile) ||
      !toAscii(config.first, &configVolume) || !toAscii(config.second, &configFile)) return false;
  canonical += "home:" + homeVolume + ":" + homeFile + "\nconfig:" + configVolume + ":" + configFile + "\n";
  if (canonical.size() > 16 * 1024) return false;
  unsigned char digest[32]{};
  if (!sha256Buffer(reinterpret_cast<const unsigned char*>(canonical.data()), static_cast<DWORD>(canonical.size()), digest)) return false;
  static constexpr char hex[] = "0123456789abcdef";
  digestHex->clear();
  digestHex->reserve(sizeof(digest) * 2);
  for (const auto byte : digest) { digestHex->push_back(hex[byte >> 4]); digestHex->push_back(hex[byte & 0x0f]); }
  SecureZeroMemory(digest, sizeof(digest));
  return true;
}

bool expectedPathChainCommitment(const char* stage, const LaunchMetadata& metadata, std::string* digest) {
  std::vector<std::pair<std::wstring, std::wstring>> components = metadata.profilePathChain;
  const std::pair<std::wstring, std::wstring> home = {
    metadata.profileHomeDirectoryVolumeSerial, metadata.profileHomeDirectoryFileId };
  const std::pair<std::wstring, std::wstring> config = {
    metadata.profileConfigVolumeSerial, metadata.profileConfigFileId };
  return pathChainCommitment(stage, metadata, components, home, config, digest);
}

bool heldPathChainCommitment(const char* stage, const LaunchMetadata& metadata,
                             const std::vector<Handle>& chain, HANDLE homeHandle, HANDLE configHandle,
                             std::string* digest) {
  std::vector<std::pair<std::wstring, std::wstring>> components;
  components.reserve(chain.size());
  for (const auto& handle : chain) {
    std::pair<std::wstring, std::wstring> identity;
    if (!handleIdentity(handle.value, &identity)) return false;
    components.push_back(std::move(identity));
  }
  std::pair<std::wstring, std::wstring> home, config;
  return handleIdentity(homeHandle, &home) && handleIdentity(configHandle, &config) &&
    pathChainCommitment(stage, metadata, components, home, config, digest);
}

bool addEvidenceRecord(std::vector<std::string>* records, const char* stage, const std::wstring& owner,
                       const std::wstring& nonce, const LaunchMetadata& metadata, const std::string& digest) {
  std::string ownerAscii, nonceAscii, runId;
  if (!toAscii(owner, &ownerAscii) || !toAscii(nonce, &nonceAscii) || !toAscii(metadata.runId, &runId) ||
      ownerAscii.size() != 64 || nonceAscii.size() != 64 || digest.size() != 64 || records->size() >= 5) return false;
  records->push_back(std::string("EBB_EVIDENCE\tV1\t") + stage + "\t" + ownerAscii + "\t" + runId + "\t" + nonceAscii + "\t" + digest + "\n");
  return records->back().size() <= 512;
}

bool trustedPathOwner(PSID owner, PSID currentUser) {
  if (EqualSid(owner, currentUser) || IsWellKnownSid(owner, WinLocalSystemSid) ||
      IsWellKnownSid(owner, WinBuiltinAdministratorsSid)) return true;
  PSID trustedInstaller = nullptr;
  if (!ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &trustedInstaller)) return false;
  const bool trusted = EqualSid(owner, trustedInstaller) != 0;
  LocalFree(trustedInstaller);
  return trusted;
}

bool trustedPathTrustee(PSID trustee, PSID currentUser) {
  return EqualSid(trustee, currentUser) || IsWellKnownSid(trustee, WinLocalSystemSid) ||
    IsWellKnownSid(trustee, WinBuiltinAdministratorsSid) || IsWellKnownSid(trustee, WinCreatorOwnerSid);
}

bool safeProfileAncestorAcl(HANDLE handle, PSID currentUser, bool verifiedVolumeRootIndex = false) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &dacl, nullptr, nullptr) != ERROR_SUCCESS || owner == nullptr || dacl == nullptr ||
      !trustedPathOwner(owner, currentUser)) return false;
  ACL_SIZE_INFORMATION info{};
  if (!GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation)) return false;
  for (DWORD index = 0; index < info.AceCount; ++index) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, index, &rawAce)) return false;
    const auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      PSID trustee = const_cast<DWORD*>(&ace->SidStart);
      const bool trusted = EqualSid(trustee, owner) || trustedPathTrustee(trustee, currentUser);
      if (!ebb::hermes::profile_path::safeAncestorAcePolicy(
          header->AceType, header->AceFlags, ace->Mask, trusted, verifiedVolumeRootIndex)) return false;
    } else if (!ebb::hermes::profile_path::safeAncestorAcePolicy(header->AceType, header->AceFlags, 0, false)) {
      return false;
    }
  }
  return true;
}

bool isCanonicalVolumeGuidRootPath(const std::wstring& path) {
  constexpr wchar_t kPrefix[] = L"\\\\?\\Volume{";
  constexpr size_t kPrefixLength = (sizeof(kPrefix) / sizeof(kPrefix[0])) - 1;
  constexpr size_t kGuidLength = 36;
  if (path.size() != kPrefixLength + kGuidLength + 2 ||
      CompareStringOrdinal(path.data(), static_cast<int>(kPrefixLength), kPrefix,
                           static_cast<int>(kPrefixLength), TRUE) != CSTR_EQUAL ||
      path[kPrefixLength + kGuidLength] != L'}' || path.back() != L'\\') return false;
  for (size_t index = 0; index < kGuidLength; ++index) {
    const wchar_t character = path[kPrefixLength + index];
    const bool separator = index == 8 || index == 13 || index == 18 || index == 23;
    const bool hexadecimal = (character >= L'0' && character <= L'9') ||
      (character >= L'a' && character <= L'f') || (character >= L'A' && character <= L'F');
    if ((separator && character != L'-') || (!separator && !hexadecimal)) return false;
  }
  return true;
}

bool verifiedVolumeRootHandle(HANDLE handle, const std::wstring& expectedVolume, const std::wstring& expectedFileId) {
  std::array<wchar_t, 32768> finalPath{};
  const DWORD pathLength = GetFinalPathNameByHandleW(handle, finalPath.data(),
    static_cast<DWORD>(finalPath.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  return pathLength != 0 && pathLength < finalPath.size() &&
    isCanonicalVolumeGuidRootPath(std::wstring(finalPath.data(), pathLength)) &&
    ticketFileIdentity(handle, expectedVolume, expectedFileId);
}

bool safePrivateProfileDirectoryAcl(HANDLE handle, PSID currentUser) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &dacl, nullptr, nullptr) != ERROR_SUCCESS || owner == nullptr || dacl == nullptr ||
      !EqualSid(owner, currentUser)) return false;
  ACL_SIZE_INFORMATION info{};
  if (!GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation)) return false;
  for (DWORD index = 0; index < info.AceCount; ++index) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, index, &rawAce)) return false;
    const auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      PSID trustee = const_cast<DWORD*>(&ace->SidStart);
      if (!trustedPathTrustee(trustee, currentUser)) return false;
    } else if (header->AceType != ACCESS_DENIED_ACE_TYPE && header->AceType != SYSTEM_AUDIT_ACE_TYPE) {
      return false;
    }
  }
  return true;
}

bool currentProcessUserSid(std::vector<unsigned char>* storage, PSID* sid) {
  Handle token;
  HANDLE rawToken = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)) return false;
  token.reset(rawToken);
  DWORD required = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &required);
  if (required == 0) return false;
  storage->resize(required);
  if (!GetTokenInformation(token.value, TokenUser, storage->data(), required, &required)) return false;
  *sid = reinterpret_cast<TOKEN_USER*>(storage->data())->User.Sid;
  return IsValidSid(*sid) != FALSE;
}

bool splitCanonicalProfilePath(const std::wstring& input, std::wstring* volumeRoot,
                               std::vector<std::wstring>* components) {
  std::wstring pathname = input;
  if (pathname.size() >= 7 && pathname.compare(0, 4, L"\\\\?\\") == 0) pathname.erase(0, 4);
  if (pathname.size() < 3 || !((pathname[0] >= L'A' && pathname[0] <= L'Z') || (pathname[0] >= L'a' && pathname[0] <= L'z')) ||
      pathname[1] != L':' || pathname[2] != L'\\') return false;
  *volumeRoot = L"\\\\?\\" + pathname.substr(0, 3);
  size_t offset = 3;
  while (offset < pathname.size()) {
    if (pathname[offset] == L'\\') return false;
    const size_t separator = pathname.find(L'\\', offset);
    const size_t end = separator == std::wstring::npos ? pathname.size() : separator;
    std::wstring component = pathname.substr(offset, end - offset);
    if (component.empty() || component == L"." || component == L".." || component.find(L':') != std::wstring::npos) return false;
    components->push_back(std::move(component));
    if (components->size() >= kMaxProfilePathComponents) return false;
    if (separator == std::wstring::npos) break;
    offset = separator + 1;
    if (offset == pathname.size()) return false;
  }
  return !components->empty();
}

using NtCreateFileProc = NTSTATUS (NTAPI *)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
  PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

bool openProfileDirectoryRelative(HANDLE parent, const std::wstring& name, HANDLE* opened) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto ntCreateFile = ntdll ? reinterpret_cast<NtCreateFileProc>(GetProcAddress(ntdll, "NtCreateFile")) : nullptr;
  if (!ntCreateFile || name.empty() || name.size() > 255) return false;
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = ntCreateFile(&handle, FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN,
    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  if (status < 0) return false;
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(handle);
    return false;
  }
  *opened = handle;
  return true;
}

bool openProfileFileRelative(HANDLE parent, const std::wstring& name, HANDLE* opened) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto ntCreateFile = ntdll ? reinterpret_cast<NtCreateFileProc>(GetProcAddress(ntdll, "NtCreateFile")) : nullptr;
  if (!ntCreateFile || name.empty() || name.size() > 255) return false;
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = ntCreateFile(&handle, FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_OPEN,
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  if (status < 0) return false;
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    CloseHandle(handle);
    return false;
  }
  *opened = handle;
  return true;
}

bool openTicketExecutable(const LaunchMetadata& metadata, Handle* handle) {
  handle->reset(CreateFileW(metadata.executable.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!*handle) return false;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return GetFileInformationByHandleEx(handle->value, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
    (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
    ticketFileIdentity(handle->value, metadata.executableVolumeSerial, metadata.executableFileId);
}

bool openTicketHermesLauncher(const LaunchMetadata& metadata, Handle* handle) {
  handle->reset(CreateFileW(metadata.hermesExecutable.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!*handle) return false;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return GetFileInformationByHandleEx(handle->value, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
    (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
    ticketFileIdentity(handle->value, metadata.hermesVolumeSerial, metadata.hermesFileId);
}

bool openTicketProfileChain(const LaunchMetadata& metadata, std::vector<Handle>* handles,
                            const char** failureCode = nullptr) {
  const auto fail = [failureCode](const char* code) {
    if (failureCode) *failureCode = code;
    return false;
  };
  std::wstring volumeRoot;
  std::vector<std::wstring> components;
  if (metadata.profilePathChain.size() < 4 ||
      !splitCanonicalProfilePath(metadata.profileHome, &volumeRoot, &components) ||
      components.size() + 1 != metadata.profilePathChain.size() ||
      metadata.authRootIndex + 3 != metadata.profilePathChain.size()) {
    return fail("LAUNCH_TICKET_PROFILE_CHAIN_SHAPE_MISMATCH");
  }

  std::wstring canonicalAuthRoot = metadata.profileHome;
  if (canonicalAuthRoot.size() >= 4 && canonicalAuthRoot.compare(0, 4, L"\\\\?\\") == 0) canonicalAuthRoot.erase(0, 4);
  size_t prefixLength = 3;
  for (DWORD index = 1; index <= metadata.authRootIndex; ++index) {
    prefixLength += components[index - 1].size() + (index == 1 ? 0 : 1);
  }
  if (prefixLength > canonicalAuthRoot.size()) return fail("LAUNCH_TICKET_PROFILE_PATH_BINDING_MISMATCH");
  canonicalAuthRoot.resize(prefixLength);
  std::wstring expectedProfile = canonicalAuthRoot + L"\\profiles\\ebb-orchestrator-run-" + metadata.runId;
  if (_wcsicmp(expectedProfile.c_str(), (metadata.profileHome.size() >= 4 && metadata.profileHome.compare(0, 4, L"\\\\?\\") == 0
      ? metadata.profileHome.substr(4) : metadata.profileHome).c_str()) != 0) {
    return fail("LAUNCH_TICKET_PROFILE_PATH_BINDING_MISMATCH");
  }

  std::vector<unsigned char> sidStorage;
  PSID currentUser = nullptr;
  if (!currentProcessUserSid(&sidStorage, &currentUser)) return fail("LAUNCH_TICKET_PROFILE_ROOT_UNSAFE");
  const auto verifyComponent = [&](HANDLE handle, size_t index) {
    const auto& expected = metadata.profilePathChain[index];
    if (index == 0) {
      return verifiedVolumeRootHandle(handle, expected.first, expected.second) &&
        safeProfileAncestorAcl(handle, currentUser, true);
    }
    if (!ticketFileIdentity(handle, expected.first, expected.second)) return false;
    if (index < metadata.authRootIndex) return safeProfileAncestorAcl(handle, currentUser);
    return safePrivateProfileDirectoryAcl(handle, currentUser);
  };

  Handle volumeRootHandle(CreateFileW(volumeRoot.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!volumeRootHandle) return fail("LAUNCH_TICKET_PROFILE_ROOT_UNSAFE");
  FILE_ATTRIBUTE_TAG_INFO rootTag{};
  if (!GetFileInformationByHandleEx(volumeRootHandle.value, FileAttributeTagInfo, &rootTag, sizeof(rootTag)) ||
      (rootTag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (rootTag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !verifyComponent(volumeRootHandle.value, 0)) return fail("LAUNCH_TICKET_PROFILE_ROOT_UNSAFE");
  handles->push_back(std::move(volumeRootHandle));

  for (size_t index = 0; index < components.size(); ++index) {
    HANDLE child = INVALID_HANDLE_VALUE;
    if (!openProfileDirectoryRelative(handles->back().value, components[index], &child)) {
      return fail("LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
    }
    Handle directory(child);
    const size_t chainIndex = index + 1;
    if (!verifyComponent(directory.value, chainIndex)) return fail("LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
    handles->push_back(std::move(directory));
  }
  if (handles->size() != metadata.profilePathChain.size() ||
      !ticketFileIdentity(handles->back().value, metadata.profileVolumeSerial, metadata.profileFileId)) {
    return fail("LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
  }
  return true;
}

bool openTicketProfileTargets(const LaunchMetadata& metadata, const std::vector<Handle>& profileChain,
                              Handle* home, Handle* config) {
  if (profileChain.empty()) return false;
  std::vector<unsigned char> sidStorage;
  PSID currentUser = nullptr;
  if (!currentProcessUserSid(&sidStorage, &currentUser)) return false;
  HANDLE homeHandle = INVALID_HANDLE_VALUE;
  if (!openProfileDirectoryRelative(profileChain.back().value, L"home", &homeHandle)) return false;
  home->reset(homeHandle);
  if (!safePrivateProfileDirectoryAcl(home->value, currentUser) ||
      !ticketFileIdentity(home->value, metadata.profileHomeDirectoryVolumeSerial, metadata.profileHomeDirectoryFileId)) return false;
  HANDLE configHandle = INVALID_HANDLE_VALUE;
  if (!openProfileFileRelative(profileChain.back().value, L"config.yaml", &configHandle)) return false;
  config->reset(configHandle);
  BY_HANDLE_FILE_INFORMATION configDetails{};
  return GetFileInformationByHandle(config->value, &configDetails) && configDetails.nNumberOfLinks == 1 &&
    safePrivateProfileDirectoryAcl(config->value, currentUser) &&
    ticketFileIdentity(config->value, metadata.profileConfigVolumeSerial, metadata.profileConfigFileId);
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
                           const std::vector<Handle>& profileChain, HANDLE profileHomeDirectory, HANDLE profileConfig,
                           std::string* verifiedPathChainCommitment = nullptr,
                           const char* commitmentStage = nullptr) {
  Handle currentExecutable;
  Handle currentHermes;
  Handle currentHome;
  Handle currentConfig;
  std::vector<Handle> currentProfileChain;
  return openTicketExecutable(metadata, &currentExecutable) &&
    openTicketHermesLauncher(metadata, &currentHermes) &&
    openTicketProfileChain(metadata, &currentProfileChain) &&
    openTicketProfileTargets(metadata, currentProfileChain, &currentHome, &currentConfig) &&
    currentProfileChain.size() == profileChain.size() &&
    std::equal(profileChain.begin(), profileChain.end(), currentProfileChain.begin(), [](const Handle& left, const Handle& right) {
      FILE_ID_INFO leftId{}, rightId{};
      return GetFileInformationByHandleEx(left.value, FileIdInfo, &leftId, sizeof(leftId)) &&
        GetFileInformationByHandleEx(right.value, FileIdInfo, &rightId, sizeof(rightId)) &&
        leftId.VolumeSerialNumber == rightId.VolumeSerialNumber &&
        memcmp(leftId.FileId.Identifier, rightId.FileId.Identifier, sizeof(leftId.FileId.Identifier)) == 0;
    }) &&
    ticketFileIdentity(executable, metadata.executableVolumeSerial, metadata.executableFileId) &&
    ticketFileIdentity(hermes, metadata.hermesVolumeSerial, metadata.hermesFileId) &&
    ticketFileIdentity(profileChain.back().value, metadata.profileVolumeSerial, metadata.profileFileId) &&
    ticketFileIdentity(profileHomeDirectory, metadata.profileHomeDirectoryVolumeSerial, metadata.profileHomeDirectoryFileId) &&
    ticketFileIdentity(profileConfig, metadata.profileConfigVolumeSerial, metadata.profileConfigFileId) &&
    (!verifiedPathChainCommitment || (commitmentStage && heldPathChainCommitment(commitmentStage, metadata,
      currentProfileChain, currentHome.value, currentConfig.value, verifiedPathChainCommitment)));
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
  if (!job || jobCreateError == ERROR_ALREADY_EXISTS) { report("JOB_CREATE_FAILED_OR_EXISTS"); return false; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { report("JOB_POLICY_FAILED"); return false; }

  SetLastError(ERROR_SUCCESS);
  Handle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(MappingData), mappingName(id).c_str()));
  const DWORD mappingCreateError = GetLastError();
  if (!mapping || mappingCreateError == ERROR_ALREADY_EXISTS) { report("MAPPING_CREATE_FAILED_OR_EXISTS"); return false; }
  if (!writeStdout("EBB_HELPER_READY\n")) return false;
  LaunchMetadata metadata;
  if (!readMetadata(&metadata)) { report("LAUNCH_FRAME_INVALID"); return false; }
  if (acceptanceEvidence && !metadata.hasHermesLaunchIdentity) { report("LAUNCH_FRAME_INVALID"); return false; }
  std::vector<std::string> evidenceRecords;
  if (acceptanceEvidence) {
    std::string digest;
    if (!expectedPathChainCommitment("FRAME_DECODED_EXPECTED", metadata, &digest) ||
        !addEvidenceRecord(&evidenceRecords, "FRAME_DECODED_EXPECTED", id, nonce, metadata, digest)) {
      report("LAUNCH_FRAME_INVALID"); return false;
    }
  }

  Handle ticketExecutable;
  Handle ticketHermes;
  Handle ticketProfileHomeDirectory;
  Handle ticketProfileConfig;
  std::vector<Handle> ticketProfileChain;
  std::vector<Handle> snapshotHandles;
  if (metadata.hasHermesLaunchIdentity) {
    if (!openTicketExecutable(metadata, &ticketExecutable)) { report("LAUNCH_TICKET_EXECUTABLE_MISMATCH"); return false; }
    if (!openTicketHermesLauncher(metadata, &ticketHermes)) { report("LAUNCH_TICKET_HERMES_MISMATCH"); return false; }
    const char* profileChainFailure = nullptr;
    if (!openTicketProfileChain(metadata, &ticketProfileChain, &profileChainFailure)) {
      report(profileChainFailure ? profileChainFailure : "LAUNCH_TICKET_PROFILE_CHAIN_MISMATCH");
      return false;
    }
    if (!openTicketProfileTargets(metadata, ticketProfileChain, &ticketProfileHomeDirectory, &ticketProfileConfig)) {
      report("LAUNCH_TICKET_PROFILE_TARGETS_MISMATCH"); return false;
    }
    const char* snapshotFailure = nullptr;
    const char* snapshotFailureStage = nullptr;
    if (!verifyHermesSourceSnapshot(metadata, &snapshotHandles, &snapshotFailure, &snapshotFailureStage)) {
      if (snapshotFailure && std::strcmp(snapshotFailure, "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH") == 0) {
        reportSnapshotTreeFailure(snapshotFailure, snapshotFailureStage);
      } else {
        report(snapshotFailure ? snapshotFailure : "LAUNCH_TICKET_SOURCE_SNAPSHOT_MISMATCH");
      }
      return false;
    }
  }
  if (acceptanceEvidence) {
    std::string digest;
    if (!heldPathChainCommitment("SUPERVISOR_OPEN", metadata, ticketProfileChain,
        ticketProfileHomeDirectory.value, ticketProfileConfig.value, &digest) ||
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
  if (acceptanceEvidence) {
    std::string digest;
    if (!ticketPathsStillMatch(metadata, ticketExecutable.value, ticketHermes.value, ticketProfileChain,
          ticketProfileHomeDirectory.value, ticketProfileConfig.value, &digest, "PRE_CREATE") ||
        !addEvidenceRecord(&evidenceRecords, "PRE_CREATE", id, nonce, metadata, digest)) {
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
       !ticketPathsStillMatch(metadata, ticketExecutable.value, ticketHermes.value, ticketProfileChain,
         ticketProfileHomeDirectory.value, ticketProfileConfig.value) ||
       !verifyHermesSourceSnapshot(metadata, nullptr))) {
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
  // second image-ID check. The profile handle likewise pins the authorized Hermes home until resume.
  std::string preResumeDigest;
  if (metadata.hasHermesLaunchIdentity &&
      (!processImageMatchesTicket(payload.value, ticketExecutable.value) ||
       !ticketPathsStillMatch(metadata, ticketExecutable.value, ticketHermes.value, ticketProfileChain,
         ticketProfileHomeDirectory.value, ticketProfileConfig.value,
         acceptanceEvidence ? &preResumeDigest : nullptr, acceptanceEvidence ? "PRE_RESUME" : nullptr) ||
       !verifyHermesSourceSnapshot(metadata, nullptr) ||
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
    if (!queryJob(job.value, &active, &processIds)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
    if (active == 0) break;
    if (!launchControlChannelHealthy()) {
      if (!TerminateJobObject(job.value, 1)) { report("LAUNCH_CONTROL_CHANNEL_LOST"); return false; }
      const ULONGLONG stopDeadline = GetTickCount64() + kStopTimeoutMs;
      do {
        if (!queryJob(job.value, &active, &processIds)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
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
    if (!heldPathChainCommitment("STOPPED_HELD", metadata, ticketProfileChain,
        ticketProfileHomeDirectory.value, ticketProfileConfig.value, &digest) ||
        !addEvidenceRecord(&evidenceRecords, "STOPPED_HELD", id, nonce, metadata, digest) ||
        evidenceRecords.size() != 5) {
      report("HERMES_TICKET_OBJECT_MISMATCH"); return false;
    }
    // The payload Job is already empty. These bounded records are emitted while every pinned
    // source/profile HANDLE remains alive and are never part of the normal launch protocol.
    std::string envelope;
    envelope.reserve(5 * 512 + 32);
    for (const auto& record : evidenceRecords) envelope += record;
    if (envelope.empty() || envelope.size() > 5 * 512) return false;
    char lengthHex[9]{};
    if (sprintf_s(lengthHex, "%08x", static_cast<unsigned int>(envelope.size())) != 8) return false;
    envelope += "EBB_EVIDENCE_END_V1:";
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
  bool launchPending
) {
  Handle job(OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE, FALSE, jobName(id).c_str()));
  if (!job) {
    const DWORD error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND) return writeStdout("UNKNOWN\tJOB_OPEN_UNAVAILABLE\n");
    if (launchPending) return writeStdout("UNKNOWN\tJOB_ABSENT_LAUNCH_PENDING\n");
    if (ownerState == L"PREPARED") {
      return hasHelperIdentity
        ? writeStdout("UNKNOWN\tJOB_ABSENT_PREPARED_HAS_HELPER_IDENTITY\n")
        : writeStdout("STOPPED\tOWNER_NEVER_LAUNCHED\n");
    }
    if (ownerState != L"LAUNCHING" && ownerState != L"LIVE" && ownerState != L"STOPPING" &&
        ownerState != L"STOPPED" && ownerState != L"UNKNOWN") {
      return writeStdout("UNKNOWN\tJOB_ABSENT_OWNER_STATE_UNKNOWN\n");
    }
    if (!hasHelperIdentity) return writeStdout("UNKNOWN\tJOB_ABSENT_HELPER_IDENTITY_MISSING\n");
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
  std::vector<ULONG_PTR> processIds;
  if (!queryJob(job.value, &active, &processIds)) return writeStdout("UNKNOWN\tJOB_ACCOUNTING_UNAVAILABLE\n");
  if (active == 0) { writeStdout("STOPPED\tJOB_EMPTY\n"); return true; }
  if (!printIdentity("LIVE", id, nonce, identity)) { report("IDENTITY_OUTPUT_FAILED"); return false; }
  return true;
}

bool stop(const std::wstring& id, const std::wstring& nonce) {
  Handle job, mapping;
  Identity identity{};
  if (!openOwnerObjects(id, nonce, &job, &mapping, &identity)) { report("JOB_OR_IDENTITY_UNAVAILABLE"); return false; }
  DWORD active = 0;
  std::vector<ULONG_PTR> processIds;
  if (!queryJob(job.value, &active, &processIds)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
  if (active == 0) { writeStdout("STOPPED\tJOB_EMPTY\n"); return true; }
  if (!TerminateJobObject(job.value, 1)) { report("JOB_TERMINATE_FAILED"); return false; }
  const ULONGLONG deadline = GetTickCount64() + kStopTimeoutMs;
  do {
    if (!queryJob(job.value, &active, &processIds)) { report("JOB_ACCOUNTING_UNAVAILABLE"); return false; }
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
  if (operation == L"identify-targets" && argc == 3) {
    Handle profile(CreateFileW(argv[2], FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    FILE_ATTRIBUTE_TAG_INFO tag{};
    std::vector<unsigned char> sidStorage;
    PSID currentUser = nullptr;
    if (!profile || !GetFileInformationByHandleEx(profile.value, FileAttributeTagInfo, &tag, sizeof(tag)) ||
        (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != FILE_ATTRIBUTE_DIRECTORY ||
        !currentProcessUserSid(&sidStorage, &currentUser) || !safePrivateProfileDirectoryAcl(profile.value, currentUser)) {
      report("TEST_PROFILE_UNSAFE"); return 2;
    }
    Handle home, config;
    const auto identityText = [](HANDLE handle) -> std::wstring {
      FILE_ID_INFO info{};
      if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info))) return L"";
      wchar_t volume[17]{};
      swprintf_s(volume, L"%016llx", static_cast<unsigned long long>(info.VolumeSerialNumber));
      static constexpr wchar_t hex[] = L"0123456789abcdef";
      std::wstring fileId;
      for (const unsigned char byte : info.FileId.Identifier) {
        fileId.push_back(hex[(byte >> 4) & 0x0f]); fileId.push_back(hex[byte & 0x0f]);
      }
      return std::wstring(volume) + L":" + fileId;
    };
    if (!openProfileDirectoryRelative(profile.value, L"home", &home.value) ||
        !safePrivateProfileDirectoryAcl(home.value, currentUser) ||
        !openProfileFileRelative(profile.value, L"config.yaml", &config.value) ||
        !safePrivateProfileDirectoryAcl(config.value, currentUser)) { report("TEST_TARGETS_UNSAFE"); return 2; }
    BY_HANDLE_FILE_INFORMATION configDetails{};
    if (!GetFileInformationByHandle(config.value, &configDetails) || configDetails.nNumberOfLinks != 1) {
      report("TEST_CONFIG_LINK_COUNT_INVALID"); return 2;
    }
    const auto homeId = identityText(home.value);
    const auto configId = identityText(config.value);
    if (homeId.empty() || configId.empty() || homeId == configId) { report("TEST_TARGET_IDENTITY_UNAVAILABLE"); return 2; }
    const auto splitId = [](const std::wstring& value, std::wstring* volume, std::wstring* file) {
      const size_t separator = value.find(L':');
      if (separator == std::wstring::npos) return false;
      *volume = value.substr(0, separator); *file = value.substr(separator + 1); return true;
    };
    std::wstring homeVolume, homeFile, configVolume, configFile;
    if (!splitId(homeId, &homeVolume, &homeFile) || !splitId(configId, &configVolume, &configFile)) return 2;
    std::string output;
    if (!toAscii(homeVolume, &output)) return 2;
    std::string homeFileAscii, configVolumeAscii, configFileAscii;
    if (!toAscii(homeFile, &homeFileAscii) || !toAscii(configVolume, &configVolumeAscii) || !toAscii(configFile, &configFileAscii)) return 2;
    return writeStdout("TARGETS\t" + output + "\t" + homeFileAscii + "\t" + configVolumeAscii + "\t" + configFileAscii + "\n") ? 0 : 4;
  }
  if (operation == L"hold-targets" && argc == 7 && isLowerHex(argv[3], 16) && isLowerHex(argv[4], 32) &&
      isLowerHex(argv[5], 16) && isLowerHex(argv[6], 32)) {
    Handle profile(CreateFileW(argv[2], FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    std::vector<unsigned char> sidStorage;
    PSID currentUser = nullptr;
    FILE_ATTRIBUTE_TAG_INFO tag{};
    if (!profile || !GetFileInformationByHandleEx(profile.value, FileAttributeTagInfo, &tag, sizeof(tag)) ||
        (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != FILE_ATTRIBUTE_DIRECTORY ||
        !currentProcessUserSid(&sidStorage, &currentUser) || !safePrivateProfileDirectoryAcl(profile.value, currentUser)) {
      report("TEST_PROFILE_UNSAFE"); return 2;
    }
    LaunchMetadata metadata;
    metadata.profileHomeDirectoryVolumeSerial = argv[3]; metadata.profileHomeDirectoryFileId = argv[4];
    metadata.profileConfigVolumeSerial = argv[5]; metadata.profileConfigFileId = argv[6];
    Handle home, config;
    if (!openProfileDirectoryRelative(profile.value, L"home", &home.value) ||
        !openProfileFileRelative(profile.value, L"config.yaml", &config.value) ||
        !safePrivateProfileDirectoryAcl(home.value, currentUser) || !safePrivateProfileDirectoryAcl(config.value, currentUser) ||
        !ticketFileIdentity(home.value, metadata.profileHomeDirectoryVolumeSerial, metadata.profileHomeDirectoryFileId) ||
        !ticketFileIdentity(config.value, metadata.profileConfigVolumeSerial, metadata.profileConfigFileId)) {
      report("TEST_TARGET_IDENTITY_MISMATCH"); return 2;
    }
    if (!writeStdout("TARGETS_HELD\n")) return 4;
    std::array<char, 6> command{};
    if (!readExact(command.data(), static_cast<DWORD>(command.size())) || std::memcmp(command.data(), "CHECK\n", 6) != 0) {
      report("TEST_TARGET_CHECK_INVALID"); return 3;
    }
    HANDLE profileDuplicate = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), profile.value, GetCurrentProcess(), &profileDuplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      report("TEST_PROFILE_DUPLICATE_FAILED"); return 2;
    }
    std::vector<Handle> currentChain;
    currentChain.emplace_back(profileDuplicate);
    Handle currentHome, currentConfig;
    if (!openTicketProfileTargets(metadata, currentChain, &currentHome, &currentConfig)) {
      report("TEST_TARGET_RECHECK_FAILED"); return 5;
    }
    return writeStdout("TARGETS_STABLE\n") ? 0 : 4;
  }
#endif
  if ((operation == L"launch" || operation == L"launch-evidence") && argc == 4 && isHexId(argv[2]) && isHexId(argv[3])) {
    DWORD payloadExitCode = 0;
    if (!launch(argv[2], argv[3], &payloadExitCode, operation == L"launch-evidence")) return 3;
    return static_cast<int>(payloadExitCode);
  }
  if (operation == L"inspect" && argc == 8 && isHexId(argv[2]) && isHexId(argv[3]) && isOwnerState(argv[4])) {
    DWORD helperPid = 0;
    ULONGLONG helperCreation = 0;
    bool hasHelperIdentity = false;
    const std::wstring pendingText(argv[7]);
    const bool launchPending = pendingText == L"1";
    if (!parseHelperIdentity(argv[5], argv[6], &helperPid, &helperCreation, &hasHelperIdentity)) {
      report("ARGUMENTS_INVALID");
      return 2;
    }
    if (pendingText != L"0" && pendingText != L"1") { report("ARGUMENTS_INVALID"); return 2; }
    return inspect(argv[2], argv[3], argv[4], helperPid, helperCreation, hasHelperIdentity, launchPending) ? 0 : 4;
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
