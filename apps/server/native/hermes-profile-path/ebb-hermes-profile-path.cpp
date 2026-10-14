#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <array>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

namespace {
constexpr int kInvalidInput = 2;
constexpr int kPathFileIdQueryFailed = 34;
constexpr int kPathFinalPathQueryFailed = 35;
constexpr int kPathExpectedPathMismatch = 36;
constexpr int kPathUtf8ConversionFailed = 37;
constexpr int kPathTargetOpenFailed = 40;
constexpr int kPathTargetUnsafe = 41;
constexpr int kPathComponentOpenFailed = 40;

void reportIdentityFailure(const char* stage, DWORD error = ERROR_SUCCESS, bool includeError = false) {
  std::cerr << "HERMES_PATH_IDENTITY_" << stage;
  if (includeError) std::cerr << ":WIN32_ERROR_" << error;
  std::cerr << '\n';
}

std::string narrowUtf8(const std::wstring& value) {
  const int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
    static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};
  std::string result(static_cast<size_t>(needed), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
      result.data(), needed, nullptr, nullptr) != needed) return {};
  return result;
}

bool parseWindowsPath(std::wstring path, std::vector<std::wstring>& components, std::wstring& driveRoot) {
  if (path.rfind(L"\\\\?\\", 0) == 0) path.erase(0, 4);
  if (path.size() < 3 || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\') return false;
  driveRoot = L"\\\\?\\" + path.substr(0, 3);
  size_t cursor = 3;
  while (cursor < path.size()) {
    const size_t end = path.find(L'\\', cursor);
    const std::wstring component = path.substr(cursor, end == std::wstring::npos ? path.size() - cursor : end - cursor);
    if (!component.empty()) {
      if (component == L"." || component == L".." || component.find_first_of(L"/:") != std::wstring::npos) return false;
      components.push_back(component);
    }
    if (end == std::wstring::npos) break;
    cursor = end + 1;
  }
  return !components.empty();
}

bool hasExpectedAttributes(HANDLE handle, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  return GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) != 0 &&
    (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
    ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory;
}

std::string jsonEscape(const std::string& value) {
  std::string result;
  static constexpr char hex[] = "0123456789abcdef";
  for (const unsigned char byte : value) {
    if (byte == '\\' || byte == '"') {
      result.push_back('\\');
      result.push_back(static_cast<char>(byte));
    } else if (byte < 0x20) {
      result.append("\\u00");
      result.push_back(hex[byte >> 4]);
      result.push_back(hex[byte & 0x0f]);
    } else result.push_back(static_cast<char>(byte));
  }
  return result;
}

int printFileIdentity(HANDLE handle, const std::wstring& expectedPath) {
  FILE_ID_INFO identity{};
  std::array<wchar_t, 32768> finalPath{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity))) {
    const DWORD error = GetLastError();
    reportIdentityFailure("FILE_ID_QUERY_FAILED", error, true);
    return kPathFileIdQueryFailed;
  }
  const DWORD length = GetFinalPathNameByHandleW(handle, finalPath.data(), static_cast<DWORD>(finalPath.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  const DWORD finalPathError = GetLastError();
  if (length == 0) {
    reportIdentityFailure("FINAL_PATH_QUERY_FAILED", finalPathError, true);
    return kPathFinalPathQueryFailed;
  }
  if (length >= finalPath.size()) {
    reportIdentityFailure("FINAL_PATH_BUFFER_TOO_SMALL");
    return kPathFinalPathQueryFailed;
  }
  if (CompareStringOrdinal(finalPath.data(), static_cast<int>(length), expectedPath.c_str(),
      static_cast<int>(expectedPath.size()), TRUE) != CSTR_EQUAL) {
    reportIdentityFailure("EXPECTED_PATH_MISMATCH");
    return kPathExpectedPathMismatch;
  }
  const std::string canonicalPath = narrowUtf8(std::wstring(finalPath.data(), length));
  if (canonicalPath.empty()) {
    reportIdentityFailure("UTF8_CONVERSION_FAILED");
    return kPathUtf8ConversionFailed;
  }
  char volume[17]{};
  std::snprintf(volume, sizeof(volume), "%016llx", static_cast<unsigned long long>(identity.VolumeSerialNumber));
  static constexpr char hex[] = "0123456789abcdef";
  std::string fileId;
  for (const unsigned char byte : identity.FileId.Identifier) {
    fileId.push_back(hex[byte >> 4]);
    fileId.push_back(hex[byte & 0x0f]);
  }
  std::cout << "{\"status\":\"SAFE_PATH\",\"kind\":\"file\",\"path\":\"" << jsonEscape(canonicalPath)
    << "\",\"volumeSerial\":\"" << volume << "\",\"fileId\":\"" << fileId << "\"}\n";
  return 0;
}

int verifyHostFile(const std::wstring& path) {
  std::vector<std::wstring> components;
  std::wstring driveRoot;
  if (!parseWindowsPath(path, components, driveRoot)) return kInvalidInput;
  std::wstring expectedPath = driveRoot;
  for (const std::wstring& component : components) {
    if (expectedPath.back() != L'\\') expectedPath.push_back(L'\\');
    expectedPath.append(component);
  }
  HANDLE current = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (current == INVALID_HANDLE_VALUE) return kPathTargetOpenFailed;
  if (!hasExpectedAttributes(current, false)) { CloseHandle(current); return kPathTargetUnsafe; }
  const int result = printFileIdentity(current, expectedPath);
  CloseHandle(current);
  return result;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 4 || argv[1] == nullptr || argv[2] == nullptr || argv[3] == nullptr ||
      std::wstring(argv[1]) != L"verify-host-path" || std::wstring(argv[2]) != L"file") return kInvalidInput;
  return verifyHostFile(argv[3]);
}
