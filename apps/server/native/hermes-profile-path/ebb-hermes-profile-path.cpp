#ifndef _WIN32
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#endif

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <fstream>
#include <chrono>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <sstream>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <lmcons.h>
#include "hermes-profile-path-acl-policy.h"

#else
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/types.h>
#include <signal.h>
#include <unistd.h>
#endif

namespace {

constexpr int kOk = 0;
constexpr int kInvalidInput = 2;
constexpr int kPathUnsafe = 10;
constexpr int kPathExists = 11;
constexpr int kPathCreateFailed = 12;
constexpr int kSelectionReadFailed = 20;
constexpr int kSelectionUnsupported = 21;
constexpr int kPathRootOpenFailed = 30;
constexpr int kPathRootUnsafe = 31;
constexpr int kPathComponentOpenFailed = 40;
constexpr int kPathComponentUnsafe = 50;
constexpr int kPathIdentityUnavailable = 34;
constexpr size_t kMaxConfigBytes = 256 * 1024;
constexpr size_t kMaxRunProfileConfigBytes = 64 * 1024;
constexpr size_t kMaxPathChainComponents = 64;
constexpr size_t kMaxPathChainJsonBytes = 8 * 1024;
constexpr const char* kHermesVersion = "v0.21.5+7357.g9244275";
constexpr const char* kHermesCommit = "9244275491ee0d5bc3481590b041114c4e1d399a";
constexpr const char* kProjectionVersion = "hermes-config-selection-v1";
constexpr const char* kEndpointProjectionVersion = "hermes-endpoint-projection-v1";
constexpr size_t kMaxDotEnvBytes = 256 * 1024;
constexpr size_t kMaxDotEnvLineBytes = 8 * 1024;

struct Selection {
  std::string provider;
  std::string model;
  bool endpointOverride = false;
  std::string reason;
};

struct EndpointEnvProvider {
  const char* provider;
  const char* envVar;
  const char* pinnedDefault;
};

constexpr EndpointEnvProvider kEndpointEnvProviders[] = {
  {"actual", "ACTUAL_BASE_URL", "https://api.actual.inc/v1"},
  {"arcee", "ARCEE_BASE_URL", "https://api.arcee.ai/api/v1"},
  {"copilot-acp", "COPILOT_ACP_BASE_URL", "acp://copilot"},
  {"gmi", "GMI_BASE_URL", "https://api.gmi-serving.com/v1"},
  {"lmstudio", "LM_BASE_URL", "http://127.0.0.1:1234/v1"},
  {"nebius-token-factory", "NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1"},
  {"nvidia", "NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"},
  {"ollama-cloud", "OLLAMA_BASE_URL", "https://ollama.com/v1"},
  {"openai-api", "OPENAI_BASE_URL", "https://api.openai.com/v1"},
  {"qwen-oauth", "HERMES_QWEN_BASE_URL", "https://portal.qwen.ai/v1"},
  {"stepfun", "STEPFUN_BASE_URL", "https://api.stepfun.ai/step_plan/v1"},
  {"tencent-tokenplan", "TOKENPLAN_BASE_URL", "https://api.lkeap.cloud.tencent.com/plan/anthropic"},
  {"upstage", "UPSTAGE_BASE_URL", "https://api.upstage.ai/v1"},
  {"xai", "XAI_BASE_URL", "https://api.x.ai/v1"},
  {"xai-oauth", "XAI_BASE_URL", "https://api.x.ai/v1"},
};

enum class DotEnvValueState { Missing, Empty, PinnedDefault, Different, Unsupported, Unsafe };

struct DotEnvValue {
  bool filePresent = false;
  DotEnvValueState state = DotEnvValueState::Missing;
};

std::string trim(std::string value);

const EndpointEnvProvider* endpointEnvProvider(const std::string& provider) {
  for (const auto& candidate : kEndpointEnvProviders) {
    if (provider == candidate.provider) return &candidate;
  }
  return nullptr;
}

DotEnvValueState compareDotEnvValue(std::string raw, const std::string& pinnedDefault) {
  if (!raw.empty() && raw.back() == '\r') raw.pop_back();
  const auto initialFirst = raw.find_first_not_of(" \t");
  if (initialFirst != std::string::npos && initialFirst > 0 && raw[initialFirst] == '#')
    return DotEnvValueState::Empty;
  const auto first = raw.find_first_not_of(" \t");
  if (first == std::string::npos) return DotEnvValueState::Empty;
  const auto last = raw.find_last_not_of(" \t");
  raw = raw.substr(first, last - first + 1);
  if (raw.front() == '\'' || raw.front() == '"') {
    const char quote = raw.front();
    const size_t closing = raw.find(quote, 1);
    if (closing == std::string::npos) return DotEnvValueState::Unsupported;
    const std::string suffix = trim(raw.substr(closing + 1));
    if (!suffix.empty() && suffix.front() != '#') return DotEnvValueState::Unsupported;
    raw = raw.substr(1, closing - 1);
    if (raw.find_first_of("\\$\r\n") != std::string::npos || raw.find(quote) != std::string::npos)
      return DotEnvValueState::Unsupported;
  } else {
    const size_t comment = raw.find(" #");
    if (comment != std::string::npos) raw = trim(raw.substr(0, comment));
    if (raw.find_first_of(" \t'\"\\$") != std::string::npos) return DotEnvValueState::Unsupported;
  }
  for (unsigned char character : raw) {
    if (character < 0x20 || character == 0x7f) return DotEnvValueState::Unsupported;
  }
  if (raw.empty()) return DotEnvValueState::Empty;
  return raw == pinnedDefault ? DotEnvValueState::PinnedDefault : DotEnvValueState::Different;
}

// The scanner keeps only the selected key and its value in memory. Other dotenv values are skipped
// byte-by-byte; they are neither copied to diagnostics nor parsed as potential credentials.
DotEnvValue scanDotEnv(const std::function<int()>& nextByte, const std::string& selectedKey,
                       const std::string& pinnedDefault) {
  DotEnvValue result;
  result.filePresent = true;
  size_t lineBytes = 0;
  std::string left;
  std::string selectedValue;
  bool commentLine = false;
  bool selectedLine = false;
  bool sawEquals = false;
  size_t occurrences = 0;
  bool failed = false;

  auto finishLine = [&]() {
    if (selectedLine) {
      ++occurrences;
      if (occurrences > 1) failed = true;
      result.state = compareDotEnvValue(selectedValue, pinnedDefault);
    }
    left.clear();
    selectedValue.clear();
    commentLine = false;
    selectedLine = false;
    sawEquals = false;
    lineBytes = 0;
  };

  while (true) {
    const int next = nextByte();
    if (next == -2) return {true, DotEnvValueState::Unsafe};
    if (next < 0) break;
    const char byte = static_cast<char>(next);
    if (byte == '\n') { finishLine(); continue; }
    if (++lineBytes > kMaxDotEnvLineBytes) return {true, DotEnvValueState::Unsupported};
    if (commentLine) continue;
    if (!sawEquals) {
      if (left.empty() && (byte == ' ' || byte == '\t' || byte == '\r')) { left.push_back(byte); continue; }
      if (left.empty() && byte == '#') { commentLine = true; continue; }
      if (byte == '=') {
        std::string key = trim(left);
        if (key.rfind("export ", 0) == 0) key = trim(key.substr(7));
        if (!key.empty() && static_cast<unsigned char>(key[0]) == 0xEF && key.size() >= 3 &&
            static_cast<unsigned char>(key[1]) == 0xBB && static_cast<unsigned char>(key[2]) == 0xBF)
          key.erase(0, 3);
        selectedLine = key == selectedKey;
        sawEquals = true;
        continue;
      }
      if (left.size() < 256) left.push_back(byte);
      else return {true, DotEnvValueState::Unsupported};
      continue;
    }
    if (selectedLine) selectedValue.push_back(byte);
  }
  if (lineBytes != 0 || sawEquals || !left.empty()) finishLine();
  if (failed) return {true, DotEnvValueState::Unsupported};
  if (occurrences == 0) result.state = DotEnvValueState::Missing;
  return result;
}

DotEnvValueState combineDotEnvPrecedence(const DotEnvValue& profile, const DotEnvValue& project,
                                         bool explicitPresent, DotEnvValueState explicitValue) {
  // Hermes source: user HERMES_HOME .env overrides the child environment. The installation
  // PROJECT_ROOT .env then fills only absent variables when the user .env exists; if it does not,
  // the project dotenv overrides the child environment.
  if (profile.filePresent) {
    if (profile.state != DotEnvValueState::Missing) return profile.state;
    if (explicitPresent) return explicitValue;
    return project.state;
  }
  if (project.state != DotEnvValueState::Missing) return project.state;
  return explicitPresent ? explicitValue : DotEnvValueState::Missing;
}

bool isSafeRunId(const std::string& value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' ||
      value[14] != '4' || (value[19] != '8' && value[19] != '9' && value[19] != 'a' && value[19] != 'b')) return false;
  for (size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    const char character = value[index];
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
  }
  return true;
}

bool isSafeProviderId(const std::string& value) {
  if (value.empty() || value.size() > 128 ||
      !std::isalnum(static_cast<unsigned char>(value.front()))) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char c) {
    return std::isalnum(c) || c == '.' || c == '_' || c == ':' || c == '-';
  });
}

bool isSafeModelId(const std::string& value) {
  if (value.empty() || value.size() > 256 ||
      !std::isalnum(static_cast<unsigned char>(value.front()))) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char c) {
    return std::isalnum(c) || c == '.' || c == '_' || c == ':' || c == '-' || c == '/' || c == '+';
  });
}

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::string scalarToken(const std::string& raw) {
  std::string value = trim(raw);
  if (value.empty()) return {};
  if (value.front() == '\'' || value.front() == '"') {
    const char quote = value.front();
    if (value.size() < 2 || value.back() != quote) return {};
    value = value.substr(1, value.size() - 2);
    if (value.find(quote) != std::string::npos || value.find('\\') != std::string::npos) return {};
  } else {
    const auto comment = value.find(" #");
    if (comment != std::string::npos) value = trim(value.substr(0, comment));
  }
  if (value.empty() || value.find_first_of(" \t\r\n${}[]&*!|>") != std::string::npos) return {};
  return value;
}

bool parseSelection(const std::function<int()>& nextByte, Selection& selection) {
  bool inModel = false;
  bool modelSectionSeen = false;
  bool providerSeen = false;
  bool modelSeen = false;
  bool rootProviderAlias = false;
  bool unsupportedLayer = false;
  size_t totalBytes = 0;
  size_t lineBytes = 0;
  size_t indent = 0;
  bool keyStarted = false;
  bool commentLine = false;
  bool sawColon = false;
  bool valueHasToken = false;
  bool commentValue = false;
  bool captureValue = false;
  std::string keyBuffer;
  std::string selectedValue;

  auto finishLine = [&]() -> bool {
    if (!commentLine && (keyStarted || sawColon)) {
      if (!sawColon) return false;
      std::string key = trim(keyBuffer);
      if (key.size() >= 3 && static_cast<unsigned char>(key[0]) == 0xEF &&
          static_cast<unsigned char>(key[1]) == 0xBB && static_cast<unsigned char>(key[2]) == 0xBF) {
        key.erase(0, 3);
      }
      if (key.empty() || key.find('\0') != std::string::npos ||
          key.find_first_of(" \t'\"{}[]&*!|>") != std::string::npos || key == "<<") return false;

      if (indent == 0) {
        inModel = key == "model";
        if (inModel) {
          if (modelSectionSeen || valueHasToken) return false;
          modelSectionSeen = true;
        } else if (key == "provider" || key == "base_url" || key == "api_base" || key == "api") {
          rootProviderAlias = true;
          if (key == "base_url" || key == "api_base" || key == "api") selection.endpointOverride = true;
        } else if (key == "providers" || key == "custom_providers" || key == "fallback_model" ||
                   key == "fallback_chain" || key == "model_catalog" || key == "secrets" || key == "plugins") {
          unsupportedLayer = true;
        }
      } else {
        if (inModel && indent > 2) return false;
        if (inModel && indent == 2) {
          if (key == "provider") {
            if (providerSeen) return false;
            providerSeen = true;
            selection.provider = scalarToken(selectedValue);
            if (selection.provider.empty()) return false;
          } else if (key == "default") {
            if (modelSeen) return false;
            modelSeen = true;
            selection.model = scalarToken(selectedValue);
            if (selection.model.empty()) return false;
          } else if (key == "base_url" || key == "api_base" || key == "api") {
            selection.endpointOverride = true;
          } else if (key == "model" || key == "name") {
            // Hermes canonicalizes these aliases, but their precedence is distinct from `model.default`.
            return false;
          } else {
            // Unknown model-selection fields can change endpoint or transport semantics (for example api_mode).
            unsupportedLayer = true;
          }
        }
      }
    }

    std::fill(keyBuffer.begin(), keyBuffer.end(), '\0');
    std::fill(selectedValue.begin(), selectedValue.end(), '\0');
    keyBuffer.clear();
    selectedValue.clear();
    lineBytes = 0;
    indent = 0;
    keyStarted = false;
    commentLine = false;
    sawColon = false;
    valueHasToken = false;
    commentValue = false;
    captureValue = false;
    return true;
  };

  while (true) {
    const int next = nextByte();
    if (next == -2) return false;
    if (next < 0) {
      if (lineBytes != 0 && !finishLine()) return false;
      break;
    }
    if (++totalBytes > kMaxConfigBytes) return false;
    const char byte = static_cast<char>(next);
    if (byte == '\n') {
      if (!finishLine()) return false;
      continue;
    }
    if (++lineBytes > 4096 || byte == '\t') return false;
    if (commentLine || commentValue) continue;

    if (!sawColon) {
      if (!keyStarted && byte == ' ') { ++indent; continue; }
      if (!keyStarted && byte == '#') { commentLine = true; continue; }
      if (byte == ':') {
        sawColon = true;
        const std::string candidateKey = trim(keyBuffer);
        captureValue = inModel && indent == 2 && (candidateKey == "provider" || candidateKey == "default");
        continue;
      }
      keyStarted = true;
      if (keyBuffer.size() >= 256) return false;
      keyBuffer.push_back(byte);
      continue;
    }

    if (!valueHasToken && byte != ' ' && byte != '\r') {
      if (byte == '#') { commentValue = true; continue; }
      valueHasToken = true;
    }
    if (captureValue) {
      if (selectedValue.size() >= 512) return false;
      selectedValue.push_back(byte);
    }
  }

  if (rootProviderAlias || unsupportedLayer) {
    selection.reason = "HERMES_SELECTION_CONFIG_UNSUPPORTED";
    return true;
  }
  if (!providerSeen || !modelSeen || selection.provider.empty() || selection.model.empty() ||
      selection.provider == "auto" || !isSafeProviderId(selection.provider) || !isSafeModelId(selection.model)) {
    selection.reason = "HERMES_SELECTION_NOT_EXPLICIT";
    return true;
  }
  return true;
}

void printUnavailable(const char* reason, bool endpointOverride = false) {
  std::cout << "{\"sourceVersion\":\"" << kHermesVersion
            << "\",\"sourceCommit\":\"" << kHermesCommit
            << "\",\"projectionVersion\":\"" << kProjectionVersion
            << "\",\"status\":\"UNAVAILABLE\",\"reason\":\"" << reason
            << "\",\"endpointOverridePresent\":" << (endpointOverride ? "true" : "false") << "}\n";
}

void printSelection(const Selection& selection) {
  std::cout << "{\"sourceVersion\":\"" << kHermesVersion
            << "\",\"sourceCommit\":\"" << kHermesCommit
            << "\",\"projectionVersion\":\"" << kProjectionVersion
            << "\",\"status\":\"EXPLICIT_SELECTION\",\"providerId\":\"" << selection.provider
            << "\",\"modelId\":\"" << selection.model
            << "\",\"endpointOverridePresent\":" << (selection.endpointOverride ? "true" : "false") << "}\n";
}

void printEndpointUnavailable() {
  std::cout << "{\"sourceVersion\":\"" << kHermesVersion
            << "\",\"sourceCommit\":\"" << kHermesCommit
            << "\",\"projectionVersion\":\"" << kEndpointProjectionVersion
            << "\",\"status\":\"UNAVAILABLE\",\"reason\":\"HERMES_ENDPOINT_ID_UNAVAILABLE\"}\n";
}

void printPinnedEndpoint(const std::string& provider, const std::string& envVar) {
  std::cout << "{\"sourceVersion\":\"" << kHermesVersion
            << "\",\"sourceCommit\":\"" << kHermesCommit
            << "\",\"projectionVersion\":\"" << kEndpointProjectionVersion
            << "\",\"status\":\"PINNED_DEFAULT\",\"providerId\":\"" << provider
            << "\",\"baseUrlEnvVar\":\"" << envVar << "\"}\n";
}

bool readExplicitEndpointValue(std::string& value, bool& present) {
  std::string presentLine;
  std::string lengthLine;
  if (!std::getline(std::cin, presentLine) || !std::getline(std::cin, lengthLine)) return false;
  if ((presentLine != "0" && presentLine != "1") || lengthLine.empty() || lengthLine.size() > 5 ||
      !std::all_of(lengthLine.begin(), lengthLine.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) return false;
  size_t length = 0;
  try { length = static_cast<size_t>(std::stoul(lengthLine)); } catch (...) { return false; }
  if (length > kMaxDotEnvLineBytes || (presentLine == "0" && length != 0)) return false;
  present = presentLine == "1";
  if (!present && length != 0) return false;
  value.resize(length);
  if (length > 0 && !std::cin.read(value.data(), static_cast<std::streamsize>(length))) return false;
  return std::cin.peek() == std::char_traits<char>::eof();
}

DotEnvValueState compareExplicitEndpointValue(const std::string& value, const std::string& pinnedDefault) {
  if (value.empty()) return DotEnvValueState::Empty;
  for (unsigned char character : value) {
    if (character < 0x20 || character == 0x7f) return DotEnvValueState::Unsupported;
  }
  return value == pinnedDefault ? DotEnvValueState::PinnedDefault : DotEnvValueState::Different;
}

#ifdef _WIN32

std::wstring widenUtf8(const std::string& value) {
  if (value.empty()) return {};
  const int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (needed <= 0) return {};
  std::wstring result(static_cast<size_t>(needed), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), needed) != needed) return {};
  return result;
}

std::string narrowUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return {};
  std::string result(static_cast<size_t>(needed), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), needed, nullptr, nullptr) != needed) return {};
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
      if (component == L"." || component == L".." || component.find_first_of(L"/:\0") != std::wstring::npos) return false;
      components.push_back(component);
    }
    if (end == std::wstring::npos) break;
    cursor = end + 1;
  }
  return true;
}

std::wstring joinWindowsComponents(const std::vector<std::wstring>& components) {
  std::wstring joined;
  for (const auto& component : components) {
    if (!joined.empty()) joined.push_back(L'\\');
    joined.append(component);
  }
  return joined;
}

bool getHandleAttributes(HANDLE handle, FILE_ATTRIBUTE_TAG_INFO& info) {
  return GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) != 0;
}

bool getCurrentUserSid(std::vector<unsigned char>& storage, PSID& sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
  if (needed == 0) { CloseHandle(token); return false; }
  storage.resize(needed);
  const bool ok = GetTokenInformation(token, TokenUser, storage.data(), needed, &needed) != 0;
  CloseHandle(token);
  if (!ok) return false;
  sid = reinterpret_cast<TOKEN_USER*>(storage.data())->User.Sid;
  return IsValidSid(sid) != 0;
}

bool trustedWellKnownSid(PSID sid, PSID currentUser) {
  return EqualSid(sid, currentUser) || IsWellKnownSid(sid, WinLocalSystemSid) ||
         IsWellKnownSid(sid, WinBuiltinAdministratorsSid) || IsWellKnownSid(sid, WinCreatorOwnerSid);
}

bool trustedPathOwner(PSID owner, PSID currentUser) {
  if (EqualSid(owner, currentUser) || IsWellKnownSid(owner, WinLocalSystemSid) ||
      IsWellKnownSid(owner, WinBuiltinAdministratorsSid)) return true;
  // Windows volume roots and protected system directories may be owned by the TrustedInstaller service.
  PSID trustedInstaller = nullptr;
  if (!ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &trustedInstaller)) return false;
  const bool trusted = EqualSid(owner, trustedInstaller) != 0;
  LocalFree(trustedInstaller);
  return trusted;
}

bool safeDirectoryAcl(HANDLE handle, PSID currentUser, bool requireCurrentOwner) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, nullptr);
  if (result != ERROR_SUCCESS || owner == nullptr || dacl == nullptr) return false;
  if (requireCurrentOwner && !EqualSid(owner, currentUser)) return false;
  ACL_SIZE_INFORMATION aclInfo{};
  if (!GetAclInformation(dacl, &aclInfo, sizeof(aclInfo), AclSizeInformation)) return false;
  constexpr ACCESS_MASK kDirectoryMutationRights = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD |
    DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL;
  for (DWORD i = 0; i < aclInfo.AceCount; ++i) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, i, &rawAce)) return false;
    const auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      PSID trustee = const_cast<DWORD*>(&ace->SidStart);
      if (!trustedWellKnownSid(trustee, currentUser) && (ace->Mask & kDirectoryMutationRights) != 0) return false;
    } else if (header->AceType != ACCESS_DENIED_ACE_TYPE && header->AceType != SYSTEM_AUDIT_ACE_TYPE) {
      return false;
    }
  }
  return true;
}

bool safePrivateDirectoryAcl(HANDLE handle, PSID currentUser) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, nullptr);
  if (result != ERROR_SUCCESS || owner == nullptr || dacl == nullptr || !EqualSid(owner, currentUser)) return false;
  ACL_SIZE_INFORMATION aclInfo{};
  if (!GetAclInformation(dacl, &aclInfo, sizeof(aclInfo), AclSizeInformation)) return false;
  for (DWORD i = 0; i < aclInfo.AceCount; ++i) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, i, &rawAce)) return false;
    const auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      PSID trustee = const_cast<DWORD*>(&ace->SidStart);
      if (!trustedWellKnownSid(trustee, currentUser)) return false;
    } else if (header->AceType != ACCESS_DENIED_ACE_TYPE && header->AceType != SYSTEM_AUDIT_ACE_TYPE) {
      return false;
    }
  }
  return true;
}

bool safeReadOnlyFileAcl(HANDLE handle, PSID currentUser) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, nullptr);
  if (result != ERROR_SUCCESS || owner == nullptr || dacl == nullptr || !EqualSid(owner, currentUser)) return false;
  ACL_SIZE_INFORMATION aclInfo{};
  if (!GetAclInformation(dacl, &aclInfo, sizeof(aclInfo), AclSizeInformation)) return false;
  constexpr ACCESS_MASK kFileMutationRights = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
    FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL;
  for (DWORD i = 0; i < aclInfo.AceCount; ++i) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, i, &rawAce)) return false;
    const auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      PSID trustee = const_cast<DWORD*>(&ace->SidStart);
      if (!trustedWellKnownSid(trustee, currentUser) && (ace->Mask & kFileMutationRights) != 0) return false;
    } else if (header->AceType != ACCESS_DENIED_ACE_TYPE && header->AceType != SYSTEM_AUDIT_ACE_TYPE) {
      return false;
    }
  }
  return true;
}

bool safePathAcl(HANDLE handle, PSID currentUser, bool directory, bool protectDirectoryContents,
                 bool includeInheritedAces = false, int* failureStage = nullptr) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, nullptr);
  if (result != ERROR_SUCCESS || owner == nullptr || dacl == nullptr) { if (failureStage) *failureStage = 1; return false; }
  if (!trustedPathOwner(owner, currentUser)) { if (failureStage) *failureStage = 2; return false; }
  ACL_SIZE_INFORMATION aclInfo{};
  if (!GetAclInformation(dacl, &aclInfo, sizeof(aclInfo), AclSizeInformation)) { if (failureStage) *failureStage = 3; return false; }
  const ACCESS_MASK mutationRights = directory
    ? (protectDirectoryContents ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY : 0) |
        FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL
    : FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL;
  for (DWORD i = 0; i < aclInfo.AceCount; ++i) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, i, &rawAce)) { if (failureStage) *failureStage = 4; return false; }
    const auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (!includeInheritedAces && (header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      PSID trustee = const_cast<DWORD*>(&ace->SidStart);
      const bool trusted = EqualSid(trustee, owner) || EqualSid(trustee, currentUser) ||
        IsWellKnownSid(trustee, WinLocalSystemSid) || IsWellKnownSid(trustee, WinBuiltinAdministratorsSid) ||
        IsWellKnownSid(trustee, WinCreatorOwnerSid);
      if (!trusted && (ace->Mask & mutationRights) != 0) { if (failureStage) *failureStage = 5; return false; }
    } else if (header->AceType != ACCESS_DENIED_ACE_TYPE && header->AceType != SYSTEM_AUDIT_ACE_TYPE) {
      if (failureStage) *failureStage = 6; return false;
    }
  }
  return true;
}

bool safeAncestorPathAcl(HANDLE handle, PSID currentUser, int* failureStage = nullptr) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, nullptr);
  if (result != ERROR_SUCCESS || owner == nullptr || dacl == nullptr) { if (failureStage) *failureStage = 1; return false; }
  if (!trustedPathOwner(owner, currentUser)) { if (failureStage) *failureStage = 2; return false; }
  ACL_SIZE_INFORMATION aclInfo{};
  if (!GetAclInformation(dacl, &aclInfo, sizeof(aclInfo), AclSizeInformation)) { if (failureStage) *failureStage = 3; return false; }
  for (DWORD i = 0; i < aclInfo.AceCount; ++i) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, i, &rawAce)) { if (failureStage) *failureStage = 4; return false; }
    const auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      PSID trustee = const_cast<DWORD*>(&ace->SidStart);
      const bool trusted = EqualSid(trustee, owner) || EqualSid(trustee, currentUser) ||
        IsWellKnownSid(trustee, WinLocalSystemSid) || IsWellKnownSid(trustee, WinBuiltinAdministratorsSid) ||
        IsWellKnownSid(trustee, WinCreatorOwnerSid);
      if (!ebb::hermes::profile_path::safeAncestorAcePolicy(header->AceType, header->AceFlags, ace->Mask, trusted)) {
        if (failureStage) *failureStage = 5;
        return false;
      }
    } else if (!ebb::hermes::profile_path::safeAncestorAcePolicy(header->AceType, header->AceFlags, 0, false)) {
      if (failureStage) *failureStage = 6;
      return false;
    }
  }
  return true;
}

HANDLE openWindowsChildDirectory(HANDLE parent, const std::wstring& name, ULONG disposition,
                                 PVOID securityDescriptor = nullptr, bool canCreateChild = false,
                                 bool checkSecurity = false, ACCESS_MASK extraAccess = 0,
                                 bool shareDelete = true) {
  if (name.empty() || name.size() > 255) return INVALID_HANDLE_VALUE;
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, securityDescriptor);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const ACCESS_MASK desiredAccess = FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE |
    (canCreateChild ? FILE_ADD_SUBDIRECTORY : 0) | (checkSecurity ? READ_CONTROL : 0) | extraAccess;
  const NTSTATUS status = NtCreateFile(&handle,
    desiredAccess,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE | (shareDelete ? FILE_SHARE_DELETE : 0),
    disposition,
    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    nullptr, 0);
  if (status < 0) return INVALID_HANDLE_VALUE;
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!getHandleAttributes(handle, info) || (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(handle);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

HANDLE openWindowsChildFile(HANDLE parent, const std::wstring& name, bool shareDelete = true) {
  if (name.empty() || name.size() > 255) return INVALID_HANDLE_VALUE;
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&handle,
    FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | (shareDelete ? FILE_SHARE_DELETE : 0),
    FILE_OPEN,
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    nullptr, 0);
  if (status < 0) return INVALID_HANDLE_VALUE;
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!getHandleAttributes(handle, info) || (info.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    CloseHandle(handle);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

HANDLE createWindowsChildFileForWrite(HANDLE parent, const std::wstring& name) {
  if (name.empty() || name.size() > 255) return INVALID_HANDLE_VALUE;
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&handle,
    GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ,
    FILE_CREATE,
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    nullptr, 0);
  if (status < 0) return INVALID_HANDLE_VALUE;
  FILE_ATTRIBUTE_TAG_INFO tagInfo{};
  FILE_STANDARD_INFO standardInfo{};
  if (!getHandleAttributes(handle, tagInfo) ||
      (tagInfo.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standardInfo, sizeof(standardInfo)) ||
      standardInfo.Directory) {
    CloseHandle(handle);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

bool getSafeHandleIdentity(HANDLE handle, std::string& canonicalPath, std::string& volumeSerial, std::string& fileId) {
  FILE_ID_INFO identity{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity))) return false;
  std::array<wchar_t, 32768> finalPath{};
  const DWORD pathLength = GetFinalPathNameByHandleW(handle, finalPath.data(), static_cast<DWORD>(finalPath.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (pathLength == 0 || pathLength >= finalPath.size()) return false;
  canonicalPath = narrowUtf8(std::wstring(finalPath.data(), pathLength));
  if (canonicalPath.empty()) return false;
  char volumeBuffer[17]{};
  std::snprintf(volumeBuffer, sizeof(volumeBuffer), "%016llx", static_cast<unsigned long long>(identity.VolumeSerialNumber));
  volumeSerial = volumeBuffer;
  static constexpr char hex[] = "0123456789abcdef";
  fileId.clear();
  fileId.reserve(sizeof(identity.FileId.Identifier) * 2);
  for (const unsigned char byte : identity.FileId.Identifier) {
    fileId.push_back(hex[byte >> 4]);
    fileId.push_back(hex[byte & 0x0f]);
  }
  return true;
}

std::string jsonEscape(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());
  static constexpr char hex[] = "0123456789abcdef";
  for (const unsigned char byte : value) {
    if (byte == '\\' || byte == '"') {
      escaped.push_back('\\');
      escaped.push_back(static_cast<char>(byte));
    } else if (byte < 0x20) {
      escaped.append("\\u00");
      escaped.push_back(hex[byte >> 4]);
      escaped.push_back(hex[byte & 0x0f]);
    } else {
      escaped.push_back(static_cast<char>(byte));
    }
  }
  return escaped;
}

void printSafePathIdentity(const std::string& kind, const std::string& canonicalPath,
                           const std::string& volumeSerial, const std::string& fileId) {
  std::cout << "{\"status\":\"SAFE_PATH\",\"kind\":\"" << kind
            << "\",\"path\":\"" << jsonEscape(canonicalPath)
            << "\",\"volumeSerial\":\"" << volumeSerial << "\",\"fileId\":\"" << fileId << "\"}\n";
}

int verifySafeWindowsPath(const std::wstring& rawPath, const std::wstring& rawKind) {
  const bool directory = rawKind == L"directory";
  if (!directory && rawKind != L"file") return kInvalidInput;
  std::vector<std::wstring> components;
  std::wstring driveRoot;
  if (!parseWindowsPath(rawPath, components, driveRoot) || components.empty()) return kInvalidInput;
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return kPathUnsafe;
  HANDLE current = CreateFileW(driveRoot.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (current == INVALID_HANDLE_VALUE) return kPathRootOpenFailed;
  FILE_ATTRIBUTE_TAG_INFO rootInfo{};
  if (!getHandleAttributes(current, rootInfo) || (rootInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(current);
    return kPathRootUnsafe;
  }
  // The volume root permits creating unrelated top-level directories; it must still deny foreign delete/write-DACL rights.
  if (!safePathAcl(current, userSid, true, false, false)) {
    CloseHandle(current);
    return kPathRootUnsafe;
  }
  for (size_t index = 0; index < components.size(); ++index) {
    const bool final = index + 1 == components.size();
    HANDLE next = final && !directory
      ? openWindowsChildFile(current, components[index])
      : openWindowsChildDirectory(current, components[index], FILE_OPEN, nullptr, false, true);
    int aclFailureStage = 0;
    const bool componentIsDirectory = !final || directory;
    const bool aclSafe = next != INVALID_HANDLE_VALUE &&
      safePathAcl(next, userSid, componentIsDirectory, componentIsDirectory, final && directory, &aclFailureStage);
    if (next == INVALID_HANDLE_VALUE || !aclSafe) {
      if (next != INVALID_HANDLE_VALUE) CloseHandle(next);
      CloseHandle(current);
      return next == INVALID_HANDLE_VALUE ? kPathComponentOpenFailed + static_cast<int>(index) :
        kPathComponentUnsafe + aclFailureStage;
    }
    CloseHandle(current);
    current = next;
  }

  std::string canonicalPath;
  std::string volumeSerial;
  std::string fileId;
  const bool identityValid = getSafeHandleIdentity(current, canonicalPath, volumeSerial, fileId);
  CloseHandle(current);
  if (!identityValid) return kPathIdentityUnavailable;
  printSafePathIdentity(directory ? "directory" : "file", canonicalPath, volumeSerial, fileId);
  return kOk;
}

struct PathChainIdentity {
  std::string volumeSerial;
  std::string fileId;
};

bool windowsPathComponentsEqual(const std::vector<std::wstring>& left,
                                const std::vector<std::wstring>& right,
                                size_t count) {
  if (left.size() < count || right.size() < count) return false;
  for (size_t index = 0; index < count; ++index) {
    if (CompareStringOrdinal(left[index].c_str(), static_cast<int>(left[index].size()),
                             right[index].c_str(), static_cast<int>(right[index].size()), TRUE) != CSTR_EQUAL) return false;
  }
  return true;
}

void closePathChainHandles(std::vector<HANDLE>& handles) {
  for (auto handle = handles.rbegin(); handle != handles.rend(); ++handle) {
    if (*handle != nullptr && *handle != INVALID_HANDLE_VALUE) CloseHandle(*handle);
  }
  handles.clear();
}

int verifySafeWindowsPathChain(const std::wstring& rawPath, const std::wstring& rawKind,
                               const std::wstring& rawStrictRoot) {
  if (rawKind != L"directory") return kInvalidInput;
  std::vector<std::wstring> components;
  std::vector<std::wstring> strictComponents;
  std::wstring driveRoot;
  std::wstring strictDriveRoot;
  if (!parseWindowsPath(rawPath, components, driveRoot) || components.empty() ||
      !parseWindowsPath(rawStrictRoot, strictComponents, strictDriveRoot) || strictComponents.empty() ||
      components.size() + 1 > kMaxPathChainComponents || strictComponents.size() >= components.size() ||
      CompareStringOrdinal(driveRoot.c_str(), static_cast<int>(driveRoot.size()),
                           strictDriveRoot.c_str(), static_cast<int>(strictDriveRoot.size()), TRUE) != CSTR_EQUAL ||
      !windowsPathComponentsEqual(components, strictComponents, strictComponents.size())) return kInvalidInput;

  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return kPathUnsafe;
  std::vector<HANDLE> heldHandles;
  heldHandles.reserve(components.size() + 1);
  HANDLE volume = CreateFileW(driveRoot.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (volume == INVALID_HANDLE_VALUE) return kPathRootOpenFailed;
  heldHandles.push_back(volume);
  FILE_ATTRIBUTE_TAG_INFO rootInfo{};
  if (!getHandleAttributes(volume, rootInfo) || (rootInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !safePathAcl(volume, userSid, true, false, false)) {
    closePathChainHandles(heldHandles);
    return kPathRootUnsafe;
  }
  const size_t authRootIndex = strictComponents.size();
  std::vector<PathChainIdentity> identities;
  identities.reserve(components.size() + 1);
  auto appendIdentity = [&](HANDLE handle, const std::wstring& expectedCanonicalPath) -> bool {
    std::string canonicalPath;
    std::string volumeSerial;
    std::string fileId;
    if (!getSafeHandleIdentity(handle, canonicalPath, volumeSerial, fileId) ||
        volumeSerial.size() != 16 || fileId.size() != 32) return false;
    const std::wstring canonicalWidePath = widenUtf8(canonicalPath);
    if (canonicalWidePath.empty() ||
        CompareStringOrdinal(canonicalWidePath.c_str(), static_cast<int>(canonicalWidePath.size()),
                             expectedCanonicalPath.c_str(), static_cast<int>(expectedCanonicalPath.size()), TRUE) != CSTR_EQUAL) return false;
    if (!identities.empty() && identities.front().volumeSerial != volumeSerial) return false;
    identities.push_back({std::move(volumeSerial), std::move(fileId)});
    return true;
  };
  if (!appendIdentity(volume, driveRoot)) {
    closePathChainHandles(heldHandles);
    return kPathIdentityUnavailable;
  }

  HANDLE parent = volume;
  std::wstring expectedCanonicalPath = driveRoot;
  for (size_t index = 0; index < components.size(); ++index) {
    HANDLE next = openWindowsChildDirectory(parent, components[index], FILE_OPEN, nullptr, false, true,
      0, index + 1 < authRootIndex /* pin the protected auth-root subtree against rename */);
    if (next == INVALID_HANDLE_VALUE) {
      closePathChainHandles(heldHandles);
      return kPathComponentOpenFailed + static_cast<int>(index);
    }
    heldHandles.push_back(next);
    if (expectedCanonicalPath.empty() || expectedCanonicalPath.back() != L'\\') expectedCanonicalPath.push_back(L'\\');
    expectedCanonicalPath.append(components[index]);
    int aclFailureStage = 0;
    const size_t chainIndex = index + 1;
    const bool aclSafe = chainIndex < authRootIndex
      ? safeAncestorPathAcl(next, userSid, &aclFailureStage)
      : safePathAcl(next, userSid, true, true, index + 1 == components.size(), &aclFailureStage);
    if (!aclSafe) {
      closePathChainHandles(heldHandles);
      return kPathComponentUnsafe + aclFailureStage;
    }
    if (!appendIdentity(next, expectedCanonicalPath)) {
      closePathChainHandles(heldHandles);
      return kPathIdentityUnavailable;
    }
    parent = next;
  }

  // Refuse an unexpectedly large serialization instead of emitting an unbounded helper response.
  const size_t estimatedJsonBytes = 128 + identities.size() * 120;
  if (estimatedJsonBytes > kMaxPathChainJsonBytes) {
    closePathChainHandles(heldHandles);
    return kPathIdentityUnavailable;
  }
  std::cout << "{\"status\":\"SAFE_PATH_CHAIN\",\"profileHomePathChain\":{\"version\":1,\"authRootIndex\":"
            << authRootIndex << ",\"components\":[";
  for (size_t index = 0; index < identities.size(); ++index) {
    if (index != 0) std::cout << ',';
    std::cout << "{\"volumeSerial\":\"" << identities[index].volumeSerial
              << "\",\"fileId\":\"" << identities[index].fileId << "\"}";
  }
  std::cout << "]}}\n";
  const bool outputOk = static_cast<bool>(std::cout);
  closePathChainHandles(heldHandles);
  return outputOk ? kOk : kPathIdentityUnavailable;
}

// Verifies a file leaf beneath an explicit strict-root boundary. Ancestors before that boundary
// receive the limited traversal policy; the boundary, descendants, and file leaf remain strict.
// Every directory is opened relative to its held no-follow parent handle, and the leaf identity is
// derived from the held file handle so path replacement cannot change the reported identity.
int verifySafeWindowsFilePathChain(const std::wstring& rawPath, const std::wstring& rawStrictRoot) {
  std::vector<std::wstring> components;
  std::vector<std::wstring> strictComponents;
  std::wstring driveRoot;
  std::wstring strictDriveRoot;
  if (!parseWindowsPath(rawPath, components, driveRoot) || components.size() < 2 ||
      !parseWindowsPath(rawStrictRoot, strictComponents, strictDriveRoot) || strictComponents.empty() ||
      components.size() > kMaxPathChainComponents || strictComponents.size() >= components.size() ||
      CompareStringOrdinal(driveRoot.c_str(), static_cast<int>(driveRoot.size()),
                           strictDriveRoot.c_str(), static_cast<int>(strictDriveRoot.size()), TRUE) != CSTR_EQUAL ||
      !windowsPathComponentsEqual(components, strictComponents, strictComponents.size())) return kInvalidInput;

  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return kPathUnsafe;
  std::vector<HANDLE> heldHandles;
  heldHandles.reserve(components.size());
  HANDLE volume = CreateFileW(driveRoot.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (volume == INVALID_HANDLE_VALUE) return kPathRootOpenFailed;
  heldHandles.push_back(volume);
  FILE_ATTRIBUTE_TAG_INFO rootInfo{};
  if (!getHandleAttributes(volume, rootInfo) || (rootInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !safePathAcl(volume, userSid, true, false, false)) {
    closePathChainHandles(heldHandles);
    return kPathRootUnsafe;
  }
  std::string volumeCanonicalPath;
  std::string expectedVolumeSerial;
  std::string volumeFileId;
  if (!getSafeHandleIdentity(volume, volumeCanonicalPath, expectedVolumeSerial, volumeFileId)) {
    closePathChainHandles(heldHandles);
    return kPathIdentityUnavailable;
  }
  const std::wstring volumeCanonicalWidePath = widenUtf8(volumeCanonicalPath);
  if (expectedVolumeSerial.size() != 16 || volumeFileId.size() != 32 || volumeCanonicalWidePath.empty() ||
      CompareStringOrdinal(volumeCanonicalWidePath.c_str(),
        static_cast<int>(volumeCanonicalWidePath.size()),
        driveRoot.c_str(), static_cast<int>(driveRoot.size()), TRUE) != CSTR_EQUAL) {
    closePathChainHandles(heldHandles);
    return kPathIdentityUnavailable;
  }

  const size_t strictRootIndex = strictComponents.size();
  HANDLE parent = volume;
  std::wstring expectedCanonicalPath = driveRoot;
  for (size_t index = 0; index + 1 < components.size(); ++index) {
    HANDLE next = openWindowsChildDirectory(parent, components[index], FILE_OPEN, nullptr, false, true,
      0, index + 1 < strictRootIndex);
    if (next == INVALID_HANDLE_VALUE) {
      closePathChainHandles(heldHandles);
      return kPathComponentOpenFailed + static_cast<int>(index);
    }
    heldHandles.push_back(next);
    if (expectedCanonicalPath.empty() || expectedCanonicalPath.back() != L'\\') expectedCanonicalPath.push_back(L'\\');
    expectedCanonicalPath.append(components[index]);
    int aclFailureStage = 0;
    const size_t chainIndex = index + 1;
    const bool aclSafe = chainIndex < strictRootIndex
      ? safeAncestorPathAcl(next, userSid, &aclFailureStage)
      : safePathAcl(next, userSid, true, true, false, &aclFailureStage);
    if (!aclSafe) {
      closePathChainHandles(heldHandles);
      return kPathComponentUnsafe + aclFailureStage;
    }
    std::string canonicalPath;
    std::string volumeSerial;
    std::string fileId;
    if (!getSafeHandleIdentity(next, canonicalPath, volumeSerial, fileId) ||
        volumeSerial != expectedVolumeSerial ||
        volumeSerial.size() != 16 || fileId.size() != 32) {
      closePathChainHandles(heldHandles);
      return kPathIdentityUnavailable;
    }
    const std::wstring canonicalWidePath = widenUtf8(canonicalPath);
    if (canonicalWidePath.empty() ||
        CompareStringOrdinal(canonicalWidePath.c_str(), static_cast<int>(canonicalWidePath.size()),
                             expectedCanonicalPath.c_str(), static_cast<int>(expectedCanonicalPath.size()), TRUE) != CSTR_EQUAL) {
      closePathChainHandles(heldHandles);
      return kPathIdentityUnavailable;
    }
    parent = next;
  }

  HANDLE leaf = openWindowsChildFile(parent, components.back(), false);
  if (leaf == INVALID_HANDLE_VALUE) {
    closePathChainHandles(heldHandles);
    return kPathComponentOpenFailed + static_cast<int>(components.size() - 1);
  }
  heldHandles.push_back(leaf);
  int leafAclFailureStage = 0;
  if (!safePathAcl(leaf, userSid, false, false, false, &leafAclFailureStage)) {
    closePathChainHandles(heldHandles);
    return kPathComponentUnsafe + leafAclFailureStage;
  }
  if (expectedCanonicalPath.empty() || expectedCanonicalPath.back() != L'\\') expectedCanonicalPath.push_back(L'\\');
  expectedCanonicalPath.append(components.back());
  std::string canonicalPath;
  std::string volumeSerial;
  std::string fileId;
  const bool identityValid = getSafeHandleIdentity(leaf, canonicalPath, volumeSerial, fileId) &&
    volumeSerial == expectedVolumeSerial && volumeSerial.size() == 16 && fileId.size() == 32;
  const std::wstring canonicalWidePath = widenUtf8(canonicalPath);
  const bool canonicalMatches = !canonicalWidePath.empty() &&
    CompareStringOrdinal(canonicalWidePath.c_str(), static_cast<int>(canonicalWidePath.size()),
                         expectedCanonicalPath.c_str(), static_cast<int>(expectedCanonicalPath.size()), TRUE) == CSTR_EQUAL;
  if (!identityValid || !canonicalMatches) {
    closePathChainHandles(heldHandles);
    return kPathIdentityUnavailable;
  }
  std::cout << "{\"status\":\"SAFE_PATH_FILE_CHAIN\",\"kind\":\"file\",\"volumeSerial\":\""
            << volumeSerial << "\",\"fileId\":\"" << fileId << "\"}\n";
  const bool outputOk = static_cast<bool>(std::cout);
  closePathChainHandles(heldHandles);
  return outputOk ? kOk : kPathIdentityUnavailable;
}

HANDLE openWindowsDirectory(const std::wstring& rawPath, bool requireCurrentOwner, PSID currentUser,
                            bool canCreateChild = false, bool checkSecurity = false,
                            bool shareDelete = true, ACCESS_MASK extraAccess = 0) {
  std::vector<std::wstring> components;
  std::wstring driveRoot;
  if (!parseWindowsPath(rawPath, components, driveRoot)) return INVALID_HANDLE_VALUE;
  HANDLE volume = CreateFileW(driveRoot.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (volume == INVALID_HANDLE_VALUE) return volume;
  FILE_ATTRIBUTE_TAG_INFO rootInfo{};
  if (!getHandleAttributes(volume, rootInfo) || (rootInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(volume);
    return INVALID_HANDLE_VALUE;
  }
  HANDLE current = volume;
  if (!components.empty()) {
    const std::wstring name = joinWindowsComponents(components);
    if (name.empty() || name.size() > 32760) { CloseHandle(volume); return INVALID_HANDLE_VALUE; }
    UNICODE_STRING objectName{};
    objectName.Buffer = const_cast<PWSTR>(name.c_str());
    objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
    objectName.MaximumLength = objectName.Length;
    OBJECT_ATTRIBUTES attributes{};
    InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, volume, nullptr);
    IO_STATUS_BLOCK ioStatus{};
    HANDLE opened = INVALID_HANDLE_VALUE;
    ACCESS_MASK desiredAccess = FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE |
      (canCreateChild ? FILE_ADD_SUBDIRECTORY : 0) | (checkSecurity ? READ_CONTROL : 0) | extraAccess;
    const NTSTATUS status = NtCreateFile(&opened, desiredAccess, &attributes, &ioStatus, nullptr,
      FILE_ATTRIBUTE_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | (shareDelete ? FILE_SHARE_DELETE : 0),
      FILE_OPEN, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
    if (status < 0) { CloseHandle(volume); return INVALID_HANDLE_VALUE; }
    CloseHandle(volume);
    current = opened;
  }
  FILE_ATTRIBUTE_TAG_INFO finalInfo{};
  if (!getHandleAttributes(current, finalInfo) || (finalInfo.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (finalInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(current);
    return INVALID_HANDLE_VALUE;
  }
  if (requireCurrentOwner && !safeDirectoryAcl(current, currentUser, true)) {
    CloseHandle(current);
    return INVALID_HANDLE_VALUE;
  }
  return current;
}

bool windowsProfileContainsOnlyRunFiles(HANDLE profile) {
  std::array<unsigned char, 4096> buffer{};
  for (;;) {
    if (!GetFileInformationByHandleEx(profile, FileIdBothDirectoryInfo, buffer.data(),
        static_cast<DWORD>(buffer.size()))) {
      return GetLastError() == ERROR_NO_MORE_FILES;
    }
    auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
    for (;;) {
      const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L".." && name != L"home" && name != L"config.yaml") return false;
      if (entry->NextEntryOffset == 0) break;
      entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<unsigned char*>(entry) + entry->NextEntryOffset);
    }
  }
}

bool writeWindowsFile(HANDLE file, const std::string& content) {
  LARGE_INTEGER beginning{};
  if (!SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN) || !SetEndOfFile(file)) return false;
  size_t offset = 0;
  while (offset < content.size()) {
    const DWORD requested = static_cast<DWORD>(std::min<size_t>(content.size() - offset, 16 * 1024));
    DWORD written = 0;
    if (!WriteFile(file, content.data() + offset, requested, &written, nullptr) || written == 0) return false;
    offset += written;
  }
  return FlushFileBuffers(file) != 0;
}

bool initializeWindowsRunProfile(const std::string& rootUtf8, const std::string& runId,
                                 const std::string& configYaml) {
  if (!isSafeRunId(runId) || configYaml.empty() || configYaml.size() > kMaxRunProfileConfigBytes ||
      configYaml.find('\0') != std::string::npos || widenUtf8(configYaml).empty()) return false;
  const std::wstring root = widenUtf8(rootUtf8);
  const std::wstring leaf = widenUtf8("ebb-orchestrator-run-" + runId);
  if (root.empty() || leaf.empty()) return false;

  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return false;
  HANDLE rootHandle = openWindowsDirectory(root, true, userSid, false, true, false);
  if (rootHandle == INVALID_HANDLE_VALUE || !safeDirectoryAcl(rootHandle, userSid, true)) {
    if (rootHandle != INVALID_HANDLE_VALUE) CloseHandle(rootHandle);
    return false;
  }
  HANDLE profiles = openWindowsChildDirectory(rootHandle, L"profiles", FILE_OPEN, nullptr,
    false, true, 0, false);
  if (profiles == INVALID_HANDLE_VALUE || !safeDirectoryAcl(profiles, userSid, true)) {
    if (profiles != INVALID_HANDLE_VALUE) CloseHandle(profiles);
    CloseHandle(rootHandle);
    return false;
  }
  HANDLE profile = openWindowsChildDirectory(profiles, leaf, FILE_OPEN, nullptr,
    true, true, FILE_LIST_DIRECTORY | FILE_ADD_FILE, false);
  if (profile == INVALID_HANDLE_VALUE || !safeDirectoryAcl(profile, userSid, true) ||
      !safePrivateDirectoryAcl(profile, userSid) || !windowsProfileContainsOnlyRunFiles(profile)) {
    if (profile != INVALID_HANDLE_VALUE) CloseHandle(profile);
    CloseHandle(profiles);
    CloseHandle(rootHandle);
    return false;
  }

  HANDLE home = openWindowsChildDirectory(profile, L"home", FILE_OPEN_IF, nullptr, true, true);
  const bool safeHome = home != INVALID_HANDLE_VALUE && safeDirectoryAcl(home, userSid, true) &&
    safePrivateDirectoryAcl(home, userSid);
  if (home != INVALID_HANDLE_VALUE) CloseHandle(home);
  if (!safeHome) {
    CloseHandle(profile);
    CloseHandle(profiles);
    CloseHandle(rootHandle);
    return false;
  }

  HANDLE config = createWindowsChildFileForWrite(profile, L"config.yaml");
  const bool written = config != INVALID_HANDLE_VALUE && safeReadOnlyFileAcl(config, userSid) &&
    writeWindowsFile(config, configYaml);
  if (config != INVALID_HANDLE_VALUE) CloseHandle(config);
  CloseHandle(profile);
  CloseHandle(profiles);
  CloseHandle(rootHandle);
  return written;
}

bool readWindowsRunProfileConfig(std::string& configYaml) {
  std::array<char, 4096> buffer{};
  for (;;) {
    std::cin.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
    const std::streamsize count = std::cin.gcount();
    if (count < 0 || configYaml.size() + static_cast<size_t>(count) > kMaxRunProfileConfigBytes) return false;
    configYaml.append(buffer.data(), static_cast<size_t>(count));
    if (std::cin.eof()) break;
    if (std::cin.bad() || std::cin.fail()) return false;
  }
  return !configYaml.empty() && configYaml.find('\0') == std::string::npos && !widenUtf8(configYaml).empty();
}

bool createWindowsProfile(const std::string& rootUtf8, const std::string& runId) {
  if (!isSafeRunId(runId)) return false;
  const std::wstring root = widenUtf8(rootUtf8);
  const std::wstring leaf = widenUtf8("ebb-orchestrator-run-" + runId);
  if (root.empty() || leaf.empty()) return false;
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return false;
  HANDLE rootHandle = openWindowsDirectory(root, true, userSid, true, true);
  if (rootHandle == INVALID_HANDLE_VALUE) return false;
  if (!safeDirectoryAcl(rootHandle, userSid, true)) { CloseHandle(rootHandle); return false; }

  HANDLE profiles = openWindowsChildDirectory(rootHandle, L"profiles", FILE_OPEN, nullptr, true, true);
  if (profiles == INVALID_HANDLE_VALUE) {
    // Create the shared parent with the Hermes root's inherited ACL, without changing that ACL.
    profiles = openWindowsChildDirectory(rootHandle, L"profiles", FILE_CREATE, nullptr, true, true);
  }
  CloseHandle(rootHandle);
  if (profiles == INVALID_HANDLE_VALUE || !safeDirectoryAcl(profiles, userSid, true)) {
    if (profiles != INVALID_HANDLE_VALUE) CloseHandle(profiles);
    return false;
  }

  LPWSTR userSidText = nullptr;
  if (!ConvertSidToStringSidW(userSid, &userSidText)) { CloseHandle(profiles); return false; }
  const std::wstring sddl = std::wstring(L"O:") + userSidText + L"D:P(A;OICI;FA;;;" + userSidText + L")";
  LocalFree(userSidText);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
    CloseHandle(profiles);
    return false;
  }
  HANDLE profile = openWindowsChildDirectory(profiles, leaf, FILE_CREATE, descriptor, false, true);
  LocalFree(descriptor);
  CloseHandle(profiles);
  if (profile == INVALID_HANDLE_VALUE) return false;
  const bool privateAcl = safeDirectoryAcl(profile, userSid, true);
  CloseHandle(profile);
  return privateAcl;
}

bool windowsChildDoesNotExist(HANDLE directory, const std::wstring& name);

bool windowsDirectoryIsEmpty(HANDLE directory) {
  std::array<unsigned char, 4096> buffer{};
  for (;;) {
    if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryInfo, buffer.data(),
        static_cast<DWORD>(buffer.size()))) {
      return GetLastError() == ERROR_NO_MORE_FILES;
    }
    auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
    for (;;) {
      const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L"..") return false;
      if (entry->NextEntryOffset == 0) break;
      entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<unsigned char*>(entry) + entry->NextEntryOffset);
    }
  }
}

int cleanupWindowsProfile(const std::string& rootUtf8, const std::string& runId) {
  if (!isSafeRunId(runId)) return kInvalidInput;
  const std::wstring root = widenUtf8(rootUtf8);
  if (root.empty()) return kInvalidInput;
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return kPathUnsafe;
  HANDLE rootHandle = openWindowsDirectory(root, true, userSid, false, true);
  if (rootHandle == INVALID_HANDLE_VALUE || !safeDirectoryAcl(rootHandle, userSid, true)) {
    if (rootHandle != INVALID_HANDLE_VALUE) CloseHandle(rootHandle);
    return kPathUnsafe;
  }
  HANDLE profiles = openWindowsChildDirectory(rootHandle, L"profiles", FILE_OPEN, nullptr, false, true);
  CloseHandle(rootHandle);
  if (profiles == INVALID_HANDLE_VALUE) {
    HANDLE safeRoot = openWindowsDirectory(root, true, userSid, false, true);
    if (safeRoot == INVALID_HANDLE_VALUE) return kPathUnsafe;
    const bool absent = windowsChildDoesNotExist(safeRoot, L"profiles");
    CloseHandle(safeRoot);
    return absent ? kOk : kPathUnsafe;
  }
  if (!safeDirectoryAcl(profiles, userSid, true) || !safePrivateDirectoryAcl(profiles, userSid)) {
    CloseHandle(profiles);
    return kPathUnsafe;
  }
  const std::wstring leaf = widenUtf8("ebb-orchestrator-run-" + runId);
  HANDLE profile = openWindowsChildDirectory(profiles, leaf, FILE_OPEN, nullptr, false, true,
    DELETE | FILE_LIST_DIRECTORY);
  if (profile == INVALID_HANDLE_VALUE) {
    const bool absent = windowsChildDoesNotExist(profiles, leaf);
    CloseHandle(profiles);
    return absent ? kOk : kPathUnsafe;
  }
  if (!safeDirectoryAcl(profile, userSid, true) || !safePrivateDirectoryAcl(profile, userSid) ||
      !windowsDirectoryIsEmpty(profile)) {
    CloseHandle(profile);
    CloseHandle(profiles);
    return kPathUnsafe;
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  const bool deleted = SetFileInformationByHandle(profile, FileDispositionInfo, &disposition, sizeof(disposition)) != 0;
  CloseHandle(profile);
  CloseHandle(profiles);
  return deleted ? kOk : kPathCreateFailed;
}

bool openWindowsConfig(const std::wstring& configHome, PSID userSid, HANDLE& directory, HANDLE& file) {
  directory = openWindowsDirectory(configHome, true, userSid, false, true);
  if (directory == INVALID_HANDLE_VALUE || !safeDirectoryAcl(directory, userSid, true)) {
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
    directory = INVALID_HANDLE_VALUE;
    return false;
  }
  HANDLE opened = INVALID_HANDLE_VALUE;
  const std::wstring filename = L"config.yaml";
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(filename.c_str());
  objectName.Length = static_cast<USHORT>(filename.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, directory, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  const NTSTATUS status = NtCreateFile(&opened, GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN,
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  if (status < 0) {
    CloseHandle(directory);
    directory = INVALID_HANDLE_VALUE;
    return false;
  }
  FILE_ATTRIBUTE_TAG_INFO tagInfo{};
  FILE_STANDARD_INFO standardInfo{};
  const bool aclSafe = safeReadOnlyFileAcl(opened, userSid);
  if (!GetFileInformationByHandleEx(opened, FileAttributeTagInfo, &tagInfo, sizeof(tagInfo)) ||
      !GetFileInformationByHandleEx(opened, FileStandardInfo, &standardInfo, sizeof(standardInfo)) ||
      (tagInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || standardInfo.Directory ||
      standardInfo.EndOfFile.QuadPart < 0 || static_cast<unsigned long long>(standardInfo.EndOfFile.QuadPart) > kMaxConfigBytes ||
      !aclSafe) {
    CloseHandle(opened);
    CloseHandle(directory);
    directory = INVALID_HANDLE_VALUE;
    return false;
  }
  file = opened;
  return true;
}

bool readWindowsConfig(const std::wstring& configHome, Selection& selection) {
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return false;
  HANDLE directory = INVALID_HANDLE_VALUE;
  HANDLE file = INVALID_HANDLE_VALUE;
  if (!openWindowsConfig(configHome, userSid, directory, file)) return false;
  FILE_STANDARD_INFO beforeStandard{};
  FILE_BASIC_INFO beforeBasic{};
  if (!GetFileInformationByHandleEx(file, FileStandardInfo, &beforeStandard, sizeof(beforeStandard)) ||
      !GetFileInformationByHandleEx(file, FileBasicInfo, &beforeBasic, sizeof(beforeBasic)) ||
      beforeStandard.Directory || beforeStandard.EndOfFile.QuadPart < 0 ||
      static_cast<unsigned long long>(beforeStandard.EndOfFile.QuadPart) > kMaxConfigBytes) {
    CloseHandle(file);
    CloseHandle(directory);
    return false;
  }

  std::array<char, 4096> buffer{};
  size_t offset = 0;
  DWORD available = 0;
  size_t bufferOffset = 0;
  bool readFailed = false;
  auto nextByte = [&]() -> int {
    if (bufferOffset >= available) {
      if (offset >= static_cast<size_t>(beforeStandard.EndOfFile.QuadPart)) return -1;
      const DWORD requested = static_cast<DWORD>(std::min<size_t>(buffer.size(),
        static_cast<size_t>(beforeStandard.EndOfFile.QuadPart) - offset));
      if (!ReadFile(file, buffer.data(), requested, &available, nullptr) || available == 0) {
        readFailed = true;
        return -2;
      }
      offset += available;
      bufferOffset = 0;
    }
    return static_cast<unsigned char>(buffer[bufferOffset++]);
  };
  const bool parsed = parseSelection(nextByte, selection);
  FILE_STANDARD_INFO afterStandard{};
  FILE_BASIC_INFO afterBasic{};
  const bool stable = GetFileInformationByHandleEx(file, FileStandardInfo, &afterStandard, sizeof(afterStandard)) &&
    GetFileInformationByHandleEx(file, FileBasicInfo, &afterBasic, sizeof(afterBasic)) &&
    beforeStandard.EndOfFile.QuadPart == afterStandard.EndOfFile.QuadPart &&
    beforeBasic.LastWriteTime.QuadPart == afterBasic.LastWriteTime.QuadPart &&
    beforeBasic.ChangeTime.QuadPart == afterBasic.ChangeTime.QuadPart;
  CloseHandle(file);
  CloseHandle(directory);
  return parsed && !readFailed && stable;
}

DotEnvValue readWindowsDotEnv(const std::wstring& directoryPath, bool requirePrivateDirectory,
                              const std::string& envVar, const std::string& pinnedDefault) {
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return {true, DotEnvValueState::Unsafe};
  HANDLE directory = openWindowsDirectory(directoryPath, true, userSid, false, true);
  if (directory == INVALID_HANDLE_VALUE) return {true, DotEnvValueState::Unsafe};
  if (!safeDirectoryAcl(directory, userSid, true) ||
      (requirePrivateDirectory && !safePrivateDirectoryAcl(directory, userSid))) {
    CloseHandle(directory);
    return {true, DotEnvValueState::Unsafe};
  }

  const std::wstring filename = L".env";
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(filename.c_str());
  objectName.Length = static_cast<USHORT>(filename.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, directory, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE file = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&file, GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN,
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  CloseHandle(directory);
  if (status == static_cast<NTSTATUS>(0xC0000034L) || status == static_cast<NTSTATUS>(0xC000003AL))
    return {false, DotEnvValueState::Missing};
  if (status < 0) return {true, DotEnvValueState::Unsafe};

  FILE_ATTRIBUTE_TAG_INFO tagInfo{};
  FILE_STANDARD_INFO standardInfo{};
  FILE_BASIC_INFO before{};
  const bool tagOk = GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tagInfo, sizeof(tagInfo)) != 0;
  const bool standardOk = GetFileInformationByHandleEx(file, FileStandardInfo, &standardInfo, sizeof(standardInfo)) != 0;
  const bool basicOk = GetFileInformationByHandleEx(file, FileBasicInfo, &before, sizeof(before)) != 0;
  const bool aclOk = safeReadOnlyFileAcl(file, userSid);
  if (!tagOk || !standardOk || !basicOk ||
      (tagInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || standardInfo.Directory ||
      standardInfo.EndOfFile.QuadPart < 0 || static_cast<unsigned long long>(standardInfo.EndOfFile.QuadPart) > kMaxDotEnvBytes ||
      !aclOk) {
    CloseHandle(file);
    return {true, DotEnvValueState::Unsafe};
  }

  std::array<char, 4096> buffer{};
  size_t offset = 0;
  DWORD available = 0;
  size_t bufferOffset = 0;
  bool readFailed = false;
  auto nextByte = [&]() -> int {
    if (bufferOffset >= available) {
      if (offset >= static_cast<size_t>(standardInfo.EndOfFile.QuadPart)) return -1;
      const DWORD requested = static_cast<DWORD>(std::min<size_t>(buffer.size(),
        static_cast<size_t>(standardInfo.EndOfFile.QuadPart) - offset));
      if (!ReadFile(file, buffer.data(), requested, &available, nullptr) || available == 0) {
        readFailed = true;
        return -2;
      }
      offset += available;
      bufferOffset = 0;
    }
    return static_cast<unsigned char>(buffer[bufferOffset++]);
  };
  DotEnvValue scanned = scanDotEnv(nextByte, envVar, pinnedDefault);
  FILE_BASIC_INFO after{};
  FILE_STANDARD_INFO afterStandard{};
  const bool stable = GetFileInformationByHandleEx(file, FileBasicInfo, &after, sizeof(after)) != 0 &&
    GetFileInformationByHandleEx(file, FileStandardInfo, &afterStandard, sizeof(afterStandard)) != 0 &&
    before.LastWriteTime.QuadPart == after.LastWriteTime.QuadPart &&
    before.ChangeTime.QuadPart == after.ChangeTime.QuadPart &&
    standardInfo.EndOfFile.QuadPart == afterStandard.EndOfFile.QuadPart;
  CloseHandle(file);
  if (readFailed || !stable || scanned.state == DotEnvValueState::Unsafe) return {true, DotEnvValueState::Unsafe};
  return scanned;
}

bool windowsChildDoesNotExist(HANDLE directory, const std::wstring& name) {
  UNICODE_STRING objectName{};
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, directory, nullptr);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE file = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&file, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN,
    FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, nullptr, 0);
  if (status == static_cast<NTSTATUS>(0xC0000034L) || status == static_cast<NTSTATUS>(0xC000003AL)) return true;
  if (status < 0) return false;
  CloseHandle(file);
  return false;
}

bool profileHasNoUnsupportedLayers(const std::wstring& profilePath) {
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return false;
  HANDLE directory = openWindowsDirectory(profilePath, true, userSid, false, true);
  if (directory == INVALID_HANDLE_VALUE) return false;
  const bool safe = safeDirectoryAcl(directory, userSid, true) && safePrivateDirectoryAcl(directory, userSid) &&
    windowsChildDoesNotExist(directory, L".op.env") && windowsChildDoesNotExist(directory, L"config.yaml");
  CloseHandle(directory);
  return safe;
}

bool isExactPlannedProfilePath(const std::string& configHomeUtf8, const std::string& profileHomeUtf8,
                               const std::string& runId) {
  if (!isSafeRunId(runId)) return false;
  const std::wstring configHome = widenUtf8(configHomeUtf8);
  const std::wstring profileHome = widenUtf8(profileHomeUtf8);
  std::vector<std::wstring> configComponents;
  std::vector<std::wstring> profileComponents;
  std::wstring configDriveRoot;
  std::wstring profileDriveRoot;
  if (configHome.empty() || profileHome.empty() ||
      !parseWindowsPath(configHome, configComponents, configDriveRoot) ||
      !parseWindowsPath(profileHome, profileComponents, profileDriveRoot) ||
      _wcsicmp(configDriveRoot.c_str(), profileDriveRoot.c_str()) != 0 ||
      profileComponents.size() != configComponents.size() + 2) return false;
  for (size_t index = 0; index < configComponents.size(); ++index) {
    if (_wcsicmp(configComponents[index].c_str(), profileComponents[index].c_str()) != 0) return false;
  }
  const std::wstring expectedLeaf = widenUtf8("ebb-orchestrator-run-" + runId);
  return _wcsicmp(profileComponents[configComponents.size()].c_str(), L"profiles") == 0 &&
    profileComponents.back() == expectedLeaf;
}

bool plannedProfilePathIsSafeOrAbsent(const std::string& configHomeUtf8, const std::string& profileHomeUtf8,
                                      const std::string& runId, bool& profileExists) {
  profileExists = false;
  if (!isExactPlannedProfilePath(configHomeUtf8, profileHomeUtf8, runId)) return false;
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return false;
  HANDLE root = openWindowsDirectory(widenUtf8(configHomeUtf8), true, userSid, false, true);
  if (root == INVALID_HANDLE_VALUE || !safeDirectoryAcl(root, userSid, true)) {
    if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
    return false;
  }

  HANDLE profiles = openWindowsChildDirectory(root, L"profiles", FILE_OPEN, nullptr, false, true);
  if (profiles == INVALID_HANDLE_VALUE) {
    const bool absent = windowsChildDoesNotExist(root, L"profiles");
    CloseHandle(root);
    return absent;
  }
  CloseHandle(root);
  if (!safeDirectoryAcl(profiles, userSid, true) || !safePrivateDirectoryAcl(profiles, userSid)) {
    CloseHandle(profiles);
    return false;
  }

  const std::wstring leaf = widenUtf8("ebb-orchestrator-run-" + runId);
  HANDLE profile = openWindowsChildDirectory(profiles, leaf, FILE_OPEN, nullptr, false, true);
  if (profile == INVALID_HANDLE_VALUE) {
    const bool absent = windowsChildDoesNotExist(profiles, leaf);
    CloseHandle(profiles);
    return absent;
  }
  CloseHandle(profile);
  CloseHandle(profiles);
  profileExists = true;
  return profileHasNoUnsupportedLayers(widenUtf8(profileHomeUtf8));
}

DotEnvValueState readEndpointInputState(const std::string& pinnedDefault, bool& explicitPresent) {
  std::string raw;
  if (!readExplicitEndpointValue(raw, explicitPresent)) return DotEnvValueState::Unsafe;
  DotEnvValueState state = explicitPresent ? compareExplicitEndpointValue(raw, pinnedDefault) : DotEnvValueState::Missing;
  std::fill(raw.begin(), raw.end(), '\0');
  return state;
}

bool managedScopeCouldOverride() {
  DWORD size = GetEnvironmentVariableW(L"HERMES_MANAGED_DIR", nullptr, 0);
  if (size > 0) return true;
  return false;
}

int createProfile(const std::string& root, const std::string& runId) {
  if (!isSafeRunId(runId)) return kInvalidInput;
  return createWindowsProfile(root, runId) ? kOk : kPathCreateFailed;
}

int projectSelection(const std::string& homeUtf8, const std::string& profileHomeUtf8, const std::string& runId) {
  if (managedScopeCouldOverride()) {
    printUnavailable("HERMES_SELECTION_MANAGED_SCOPE_UNSUPPORTED");
    return kOk;
  }
  Selection selection;
  if (!readWindowsConfig(widenUtf8(homeUtf8), selection)) {
    printUnavailable("HERMES_SELECTION_CONFIG_UNSUPPORTED");
    return kOk;
  }
  bool profileExists = false;
  if (!plannedProfilePathIsSafeOrAbsent(homeUtf8, profileHomeUtf8, runId, profileExists)) {
    printUnavailable("HERMES_SELECTION_PROFILE_UNAVAILABLE");
    return kOk;
  }
  if (!selection.reason.empty() && selection.reason != "HERMES_ENDPOINT_ID_UNAVAILABLE") {
    printUnavailable(selection.reason.c_str(), selection.endpointOverride);
    return kOk;
  }
  if (selection.provider.empty() || selection.model.empty()) {
    printUnavailable("HERMES_SELECTION_NOT_EXPLICIT", selection.endpointOverride);
    return kOk;
  }
  printSelection(selection);
  return kOk;
}

int projectEndpoint(const std::string& configHomeUtf8, const std::string& profileHomeUtf8,
                    const std::string& projectRootUtf8, const std::string& expectedProvider,
                    const std::string& expectedModel, const std::string& envVar, const std::string& runId) {
  if (managedScopeCouldOverride()) { printEndpointUnavailable(); return kOk; }
  const EndpointEnvProvider* pinned = endpointEnvProvider(expectedProvider);
  if (pinned == nullptr || envVar != pinned->envVar || !isSafeProviderId(expectedProvider) ||
      !isSafeModelId(expectedModel)) { printEndpointUnavailable(); return kOk; }

  bool profileExists = false;
  if (!plannedProfilePathIsSafeOrAbsent(configHomeUtf8, profileHomeUtf8, runId, profileExists)) {
    printEndpointUnavailable(); return kOk;
  }

  bool explicitPresent = false;
  const DotEnvValueState explicitState = readEndpointInputState(pinned->pinnedDefault, explicitPresent);
  if (explicitState == DotEnvValueState::Unsafe) { printEndpointUnavailable(); return kOk; }

  Selection selection;
  if (!readWindowsConfig(widenUtf8(configHomeUtf8), selection)) {
    printEndpointUnavailable(); return kOk;
  }
  if (!selection.reason.empty() || selection.endpointOverride || selection.provider != expectedProvider ||
      selection.model != expectedModel) { printEndpointUnavailable(); return kOk; }

  const DotEnvValue profileValue = profileExists
    ? readWindowsDotEnv(widenUtf8(profileHomeUtf8), true, envVar, pinned->pinnedDefault)
    : DotEnvValue{false, DotEnvValueState::Missing};
  const DotEnvValue projectValue = readWindowsDotEnv(widenUtf8(projectRootUtf8), false, envVar, pinned->pinnedDefault);
  if (profileValue.state == DotEnvValueState::Unsafe || projectValue.state == DotEnvValueState::Unsafe ||
      profileValue.state == DotEnvValueState::Unsupported || projectValue.state == DotEnvValueState::Unsupported) {
    printEndpointUnavailable(); return kOk;
  }
  const DotEnvValueState effective = combineDotEnvPrecedence(profileValue, projectValue,
    explicitPresent, explicitState);
  if (effective != DotEnvValueState::Missing && effective != DotEnvValueState::Empty &&
      effective != DotEnvValueState::PinnedDefault) {
    printEndpointUnavailable(); return kOk;
  }
  printPinnedEndpoint(expectedProvider, envVar);
  return kOk;
}

#else

bool parsePosixPath(const std::string& path, std::vector<std::string>& components) {
  if (path.empty() || path.front() != '/' || path.find('\0') != std::string::npos) return false;
  size_t cursor = 1;
  while (cursor < path.size()) {
    const size_t end = path.find('/', cursor);
    const std::string component = path.substr(cursor, end == std::string::npos ? path.size() - cursor : end - cursor);
    if (!component.empty()) {
      if (component == "." || component == "..") return false;
      for (const unsigned char byte : component) if (byte < 0x20 || byte == 0x7f) return false;
      components.push_back(component);
    }
    if (end == std::string::npos) break;
    cursor = end + 1;
  }
  return true;
}

bool safeDirectoryStat(int fd, bool requireOwner) {
  struct stat info{};
  if (fstat(fd, &info) != 0 || !S_ISDIR(info.st_mode)) return false;
  if (requireOwner && info.st_uid != geteuid()) return false;
  const mode_t sharedWrite = info.st_mode & (S_IWGRP | S_IWOTH);
  if (sharedWrite == 0) return true;
  // Permit only the root-owned sticky system-temp ancestor (for example /tmp). Its sticky bit
  // protects entries from replacement/removal by other users; the final Hermes root remains private.
  return !requireOwner && info.st_uid == 0 && (info.st_mode & S_ISVTX) != 0;
}

int openPosixDirectory(const std::string& path, bool requireOwner) {
  std::vector<std::string> components;
  if (!parsePosixPath(path, components)) return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) return -1;
  for (const auto& component : components) {
    const int next = openat(current, component.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close(current);
    if (next < 0) return -1;
    current = next;
    if (!safeDirectoryStat(current, false)) { close(current); return -1; }
  }
  if (!safeDirectoryStat(current, requireOwner)) { close(current); return -1; }
  return current;
}

int openOrCreateProfiles(int rootFd) {
  if (mkdirat(rootFd, "profiles", 0700) != 0 && errno != EEXIST) return -1;
  const int fd = openat(rootFd, "profiles", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 || !safeDirectoryStat(fd, true)) {
    if (fd >= 0) close(fd);
    return -1;
  }
  return fd;
}

int createPosixProfile(const std::string& root, const std::string& runId) {
  const int rootFd = openPosixDirectory(root, true);
  if (rootFd < 0) return kPathUnsafe;
  const int profilesFd = openOrCreateProfiles(rootFd);
  close(rootFd);
  if (profilesFd < 0) return kPathUnsafe;
  const std::string leaf = "ebb-orchestrator-run-" + runId;
  if (mkdirat(profilesFd, leaf.c_str(), 0700) != 0) {
    const int status = errno == EEXIST ? kPathExists : kPathCreateFailed;
    close(profilesFd);
    return status;
  }
  const int profileFd = openat(profilesFd, leaf.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(profilesFd);
  if (profileFd < 0) return kPathCreateFailed;
  const int modeStatus = fchmod(profileFd, 0700);
  struct stat profileStat{};
  const bool privateDirectory = modeStatus == 0 && fstat(profileFd, &profileStat) == 0 &&
    S_ISDIR(profileStat.st_mode) && profileStat.st_uid == geteuid() && (profileStat.st_mode & 0077) == 0;
  close(profileFd);
  return privateDirectory ? kOk : kPathCreateFailed;
}

bool writePosixRunProfileConfig(int profileFd, const std::string& configYaml) {
  const int fd = openat(profileFd, "config.yaml", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (fd < 0) return false;
  struct stat info{};
  bool safeFile = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == geteuid() &&
    (info.st_mode & 0077) == 0;
  size_t offset = 0;
  while (safeFile && offset < configYaml.size()) {
    const ssize_t written = write(fd, configYaml.data() + offset, configYaml.size() - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) { safeFile = false; break; }
    offset += static_cast<size_t>(written);
  }
  if (safeFile && fsync(fd) != 0) safeFile = false;
  if (close(fd) != 0) safeFile = false;
  return safeFile && offset == configYaml.size();
}

int initializePosixRunProfile(const std::string& root, const std::string& runId,
                              const std::string& configYaml) {
  if (!isSafeRunId(runId) || configYaml.empty() || configYaml.size() > kMaxRunProfileConfigBytes ||
      configYaml.find('\0') != std::string::npos) return kInvalidInput;
  const int rootFd = openPosixDirectory(root, true);
  if (rootFd < 0) return kPathUnsafe;
  const int profilesFd = openat(rootFd, "profiles", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(rootFd);
  if (profilesFd < 0) return kPathUnsafe;
  struct stat profilesInfo{};
  if (!safeDirectoryStat(profilesFd, true) || fstat(profilesFd, &profilesInfo) != 0 ||
      (profilesInfo.st_mode & 0077) != 0) {
    close(profilesFd);
    return kPathUnsafe;
  }

  const std::string leaf = "ebb-orchestrator-run-" + runId;
  const int profileFd = openat(profilesFd, leaf.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(profilesFd);
  if (profileFd < 0) return kPathUnsafe;
  struct stat profileInfo{};
  if (!safeDirectoryStat(profileFd, true) || fstat(profileFd, &profileInfo) != 0 ||
      (profileInfo.st_mode & 0077) != 0) {
    close(profileFd);
    return kPathUnsafe;
  }

  if (mkdirat(profileFd, "home", 0700) != 0 && errno != EEXIST) {
    close(profileFd);
    return kPathCreateFailed;
  }
  const int homeFd = openat(profileFd, "home", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat homeInfo{};
  const bool safeHome = homeFd >= 0 && safeDirectoryStat(homeFd, true) && fstat(homeFd, &homeInfo) == 0 &&
    (homeInfo.st_mode & 0077) == 0;
  if (homeFd >= 0) close(homeFd);
  if (!safeHome) {
    close(profileFd);
    return kPathUnsafe;
  }

  const bool written = writePosixRunProfileConfig(profileFd, configYaml);
  close(profileFd);
  return written ? kOk : kPathCreateFailed;
}

bool readPosixRunProfileConfig(std::string& configYaml) {
  std::array<char, 4096> buffer{};
  for (;;) {
    std::cin.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
    const std::streamsize count = std::cin.gcount();
    if (count < 0 || configYaml.size() + static_cast<size_t>(count) > kMaxRunProfileConfigBytes) return false;
    configYaml.append(buffer.data(), static_cast<size_t>(count));
    if (std::cin.eof()) break;
    if (std::cin.bad() || std::cin.fail()) return false;
  }
  return !configYaml.empty() && configYaml.find('\0') == std::string::npos;
}

int cleanupPosixProfile(const std::string& root, const std::string& runId) {
  if (!isSafeRunId(runId)) return kInvalidInput;
  const int rootFd = openPosixDirectory(root, true);
  if (rootFd < 0) return kPathUnsafe;
  const int profilesFd = openat(rootFd, "profiles", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(rootFd);
  if (profilesFd < 0) return errno == ENOENT ? kOk : kPathUnsafe;
  struct stat profilesInfo{};
  if (!safeDirectoryStat(profilesFd, true) || fstat(profilesFd, &profilesInfo) != 0 ||
      (profilesInfo.st_mode & 0077) != 0) {
    close(profilesFd);
    return kPathUnsafe;
  }
  const std::string leaf = "ebb-orchestrator-run-" + runId;
  const int profileFd = openat(profilesFd, leaf.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (profileFd < 0) {
    const bool absent = errno == ENOENT;
    close(profilesFd);
    return absent ? kOk : kPathUnsafe;
  }
  struct stat profileInfo{};
  if (!safeDirectoryStat(profileFd, true) || fstat(profileFd, &profileInfo) != 0 || (profileInfo.st_mode & 0077) != 0) {
    close(profileFd);
    close(profilesFd);
    return kPathUnsafe;
  }
  const int scanFd = dup(profileFd);
  DIR* entries = scanFd >= 0 ? fdopendir(scanFd) : nullptr;
  bool empty = entries != nullptr;
  if (entries != nullptr) {
    while (const dirent* entry = readdir(entries)) {
      if (std::string(entry->d_name) != "." && std::string(entry->d_name) != "..") { empty = false; break; }
    }
    closedir(entries);
  } else if (scanFd >= 0) {
    close(scanFd);
  }
  struct stat pathInfo{};
  const bool sameProfile = fstatat(profilesFd, leaf.c_str(), &pathInfo, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISDIR(pathInfo.st_mode) && pathInfo.st_dev == profileInfo.st_dev && pathInfo.st_ino == profileInfo.st_ino;
  close(profileFd);
  if (!empty || !sameProfile) { close(profilesFd); return kPathUnsafe; }
  const int result = unlinkat(profilesFd, leaf.c_str(), AT_REMOVEDIR);
  const int status = result == 0 || errno == ENOENT ? kOk : kPathUnsafe;
  close(profilesFd);
  return status;
}

bool readPosixConfig(const std::string& home, Selection& selection) {
  const int homeFd = openPosixDirectory(home, true);
  if (homeFd < 0) return false;
  const int fd = openat(homeFd, "config.yaml", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  close(homeFd);
  if (fd < 0) return false;
  struct stat info{};
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
      (info.st_mode & (S_IWGRP | S_IWOTH)) != 0 || info.st_size < 0 ||
      static_cast<unsigned long long>(info.st_size) > kMaxConfigBytes) {
    close(fd);
    return false;
  }

  std::array<unsigned char, 4096> buffer{};
  size_t offset = 0;
  size_t available = 0;
  size_t bufferOffset = 0;
  bool readFailed = false;
  auto nextByte = [&]() -> int {
    if (bufferOffset >= available) {
      if (offset >= static_cast<size_t>(info.st_size)) return -1;
      const size_t requested = std::min<size_t>(buffer.size(), static_cast<size_t>(info.st_size) - offset);
      const ssize_t count = read(fd, buffer.data(), requested);
      if (count <= 0) { readFailed = true; return -2; }
      available = static_cast<size_t>(count);
      offset += available;
      bufferOffset = 0;
    }
    return buffer[bufferOffset++];
  };
  const bool parsed = parseSelection(nextByte, selection);
  struct stat after{};
  const bool stable = fstat(fd, &after) == 0 && info.st_dev == after.st_dev && info.st_ino == after.st_ino &&
    info.st_uid == after.st_uid && info.st_size == after.st_size &&
    info.st_mtim.tv_sec == after.st_mtim.tv_sec && info.st_mtim.tv_nsec == after.st_mtim.tv_nsec &&
    info.st_ctim.tv_sec == after.st_ctim.tv_sec && info.st_ctim.tv_nsec == after.st_ctim.tv_nsec;
  close(fd);
  return parsed && !readFailed && stable;
}

DotEnvValue readPosixDotEnv(const std::string& directoryPath, bool requirePrivateDirectory,
                            const std::string& envVar, const std::string& pinnedDefault) {
  const int directory = openPosixDirectory(directoryPath, true);
  if (directory < 0) return {true, DotEnvValueState::Unsafe};
  struct stat directoryInfo{};
  if (fstat(directory, &directoryInfo) != 0 ||
      (requirePrivateDirectory && (directoryInfo.st_mode & 0077) != 0)) {
    close(directory);
    return {true, DotEnvValueState::Unsafe};
  }
  const int fd = openat(directory, ".env", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  const int openError = errno;
  close(directory);
  if (fd < 0) {
    if (openError == ENOENT) return {false, DotEnvValueState::Missing};
    return {true, DotEnvValueState::Unsafe};
  }

  struct stat before{};
  if (fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || before.st_uid != geteuid() ||
      (before.st_mode & (S_IWGRP | S_IWOTH)) != 0 || before.st_size < 0 ||
      static_cast<unsigned long long>(before.st_size) > kMaxDotEnvBytes) {
    close(fd);
    return {true, DotEnvValueState::Unsafe};
  }
  size_t offset = 0;
  std::array<unsigned char, 4096> buffer{};
  size_t available = 0;
  size_t bufferOffset = 0;
  bool readFailed = false;
  auto nextByte = [&]() -> int {
    if (bufferOffset >= available) {
      if (offset >= static_cast<size_t>(before.st_size)) return -1;
      const size_t requested = std::min<size_t>(buffer.size(), static_cast<size_t>(before.st_size) - offset);
      const ssize_t count = read(fd, buffer.data(), requested);
      if (count <= 0) { readFailed = true; return -2; }
      available = static_cast<size_t>(count);
      offset += available;
      bufferOffset = 0;
    }
    return static_cast<unsigned char>(buffer[bufferOffset++]);
  };
  DotEnvValue scanned = scanDotEnv(nextByte, envVar, pinnedDefault);
  struct stat after{};
  const bool stable = fstat(fd, &after) == 0 && before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
    before.st_size == after.st_size && before.st_mtime == after.st_mtime && before.st_ctime == after.st_ctime;
  close(fd);
  if (readFailed || !stable || scanned.state == DotEnvValueState::Unsafe) return {true, DotEnvValueState::Unsafe};
  return scanned;
}

bool posixChildDoesNotExist(int directory, const char* name) {
  struct stat info{};
  if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0) return false;
  return errno == ENOENT;
}

bool profileHasNoUnsupportedLayers(const std::string& profilePath) {
  const int directory = openPosixDirectory(profilePath, true);
  if (directory < 0) return false;
  struct stat info{};
  const bool safeDirectory = fstat(directory, &info) == 0 && (info.st_mode & 0077) == 0;
  const bool noCredentialLayers = safeDirectory && posixChildDoesNotExist(directory, ".op.env") &&
    posixChildDoesNotExist(directory, "config.yaml");
  close(directory);
  return noCredentialLayers;
}

std::string canonicalPosixPath(const std::vector<std::string>& components);

bool isExactPlannedProfilePath(const std::string& configHome, const std::string& profileHome,
                               const std::string& runId) {
  if (!isSafeRunId(runId)) return false;
  std::vector<std::string> configComponents;
  std::vector<std::string> profileComponents;
  if (!parsePosixPath(configHome, configComponents) || !parsePosixPath(profileHome, profileComponents) ||
      canonicalPosixPath(configComponents) != configHome || canonicalPosixPath(profileComponents) != profileHome ||
      profileComponents.size() != configComponents.size() + 2) return false;
  for (size_t index = 0; index < configComponents.size(); ++index) {
    if (configComponents[index] != profileComponents[index]) return false;
  }
  return profileComponents[configComponents.size()] == "profiles" &&
    profileComponents.back() == "ebb-orchestrator-run-" + runId;
}

bool plannedProfilePathIsSafeOrAbsent(const std::string& configHome, const std::string& profileHome,
                                      const std::string& runId, bool& profileExists) {
  profileExists = false;
  if (!isExactPlannedProfilePath(configHome, profileHome, runId)) return false;
  const int root = openPosixDirectory(configHome, true);
  if (root < 0) return false;

  struct stat profilesInfo{};
  if (fstatat(root, "profiles", &profilesInfo, AT_SYMLINK_NOFOLLOW) != 0) {
    const bool absent = errno == ENOENT;
    close(root);
    return absent;
  }
  if (!S_ISDIR(profilesInfo.st_mode) || profilesInfo.st_uid != geteuid() ||
      (profilesInfo.st_mode & (0077 | S_ISUID | S_ISGID)) != 0) {
    close(root);
    return false;
  }
  const int profiles = openat(root, "profiles", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(root);
  if (profiles < 0) return false;

  const std::string leaf = "ebb-orchestrator-run-" + runId;
  struct stat profileInfo{};
  if (fstatat(profiles, leaf.c_str(), &profileInfo, AT_SYMLINK_NOFOLLOW) != 0) {
    const bool absent = errno == ENOENT;
    close(profiles);
    return absent;
  }
  if (!S_ISDIR(profileInfo.st_mode) || profileInfo.st_uid != geteuid() ||
      (profileInfo.st_mode & (0077 | S_ISUID | S_ISGID)) != 0) {
    close(profiles);
    return false;
  }
  const int profile = openat(profiles, leaf.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(profiles);
  if (profile < 0) return false;
  struct stat openedProfileInfo{};
  const bool safeProfile = fstat(profile, &openedProfileInfo) == 0 &&
    S_ISDIR(openedProfileInfo.st_mode) && openedProfileInfo.st_uid == geteuid() &&
    (openedProfileInfo.st_mode & (0077 | S_ISUID | S_ISGID)) == 0;
  close(profile);
  if (!safeProfile || !profileHasNoUnsupportedLayers(profileHome)) return false;
  profileExists = true;
  return true;
}

DotEnvValueState readEndpointInputState(const std::string& pinnedDefault, bool& explicitPresent) {
  std::string raw;
  if (!readExplicitEndpointValue(raw, explicitPresent)) return DotEnvValueState::Unsafe;
  const DotEnvValueState state = explicitPresent ? compareExplicitEndpointValue(raw, pinnedDefault) : DotEnvValueState::Missing;
  std::fill(raw.begin(), raw.end(), '\0');
  return state;
}

bool managedScopeCouldOverride() {
  if (std::getenv("HERMES_MANAGED_DIR") != nullptr) return true;
  struct stat info{};
  if (lstat("/etc/hermes", &info) == 0) return true;
  return errno != ENOENT && errno != ENOTDIR;
}

int createProfile(const std::string& root, const std::string& runId) {
  if (!isSafeRunId(runId)) return kInvalidInput;
  return createPosixProfile(root, runId);
}

std::string canonicalPosixPath(const std::vector<std::string>& components) {
  if (components.empty()) return "/";
  std::string result;
  for (const auto& component : components) {
    result.push_back('/');
    result.append(component);
  }
  return result;
}

std::string escapePosixPathForJson(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());
  constexpr char hex[] = "0123456789abcdef";
  for (const unsigned char byte : value) {
    if (byte == '\\' || byte == '"') {
      escaped.push_back('\\');
      escaped.push_back(static_cast<char>(byte));
    } else if (byte < 0x20 || byte == 0x7f) {
      escaped.append("\\u00");
      escaped.push_back(hex[byte >> 4]);
      escaped.push_back(hex[byte & 0x0f]);
    } else {
      escaped.push_back(static_cast<char>(byte));
    }
  }
  return escaped;
}

void printPosixPathIdentity(const std::string& canonicalPath, const struct stat& info) {
  std::cout << "{\"platform\":\"linux\",\"device\":\""
            << static_cast<unsigned long long>(info.st_dev) << "\",\"inode\":\""
            << static_cast<unsigned long long>(info.st_ino) << "\",\"path\":\""
            << escapePosixPathForJson(canonicalPath) << "\"}\n";
}

int verifySafePosixPath(const std::string& rawPath, const std::string& rawKind) {
  const bool directory = rawKind == "directory";
  if (!directory && rawKind != "file") return kInvalidInput;

  std::vector<std::string> components;
  if (!parsePosixPath(rawPath, components) ||
      (rawPath.size() > 1 && rawPath.back() == '/') ||
      (!directory && components.empty())) {
    return kInvalidInput;
  }

  int target = -1;
  if (directory) {
    target = openPosixDirectory(rawPath, false);
  } else {
    std::vector<std::string> parentComponents(components.begin(), components.end() - 1);
    const std::string parentPath = canonicalPosixPath(parentComponents);
    const int parent = openPosixDirectory(parentPath, false);
    if (parent < 0) return kPathUnsafe;
    target = openat(parent, components.back().c_str(), O_PATH | O_CLOEXEC | O_NOFOLLOW);
    close(parent);
  }

  if (target < 0) return kPathUnsafe;
  struct stat info{};
  const bool statSucceeded = fstat(target, &info) == 0;
  close(target);
  if (!statSucceeded) return kPathIdentityUnavailable;

  const bool ownedByTrustedPrincipal = info.st_uid == geteuid() || info.st_uid == 0;
  const bool writableByGroupOrOther = (info.st_mode & (S_IWGRP | S_IWOTH)) != 0;
  if (directory) {
    if (!S_ISDIR(info.st_mode) || !ownedByTrustedPrincipal || writableByGroupOrOther ||
        (info.st_mode & (S_ISUID | S_ISGID)) != 0) {
      return kPathUnsafe;
    }
  } else if (!S_ISREG(info.st_mode) || !ownedByTrustedPrincipal || writableByGroupOrOther ||
             (info.st_mode & (S_ISUID | S_ISGID)) != 0) {
    return kPathUnsafe;
  }

  printPosixPathIdentity(canonicalPosixPath(components), info);
  return kOk;
}

int projectSelection(const std::string& home, const std::string& profileHome, const std::string& runId) {
  if (managedScopeCouldOverride()) {
    printUnavailable("HERMES_SELECTION_MANAGED_SCOPE_UNSUPPORTED");
    return kOk;
  }
  Selection selection;
  if (!readPosixConfig(home, selection)) {
    printUnavailable("HERMES_SELECTION_CONFIG_UNSUPPORTED");
    return kOk;
  }
  bool profileExists = false;
  if (!plannedProfilePathIsSafeOrAbsent(home, profileHome, runId, profileExists)) {
    printUnavailable("HERMES_SELECTION_PROFILE_UNAVAILABLE");
    return kOk;
  }
  if (!selection.reason.empty() && selection.reason != "HERMES_ENDPOINT_ID_UNAVAILABLE") {
    printUnavailable(selection.reason.c_str(), selection.endpointOverride);
    return kOk;
  }
  if (selection.provider.empty() || selection.model.empty()) {
    printUnavailable("HERMES_SELECTION_NOT_EXPLICIT", selection.endpointOverride);
    return kOk;
  }
  printSelection(selection);
  return kOk;
}

int projectEndpoint(const std::string& configHome, const std::string& profileHome,
                    const std::string& projectRoot, const std::string& expectedProvider,
                    const std::string& expectedModel, const std::string& envVar, const std::string& runId) {
  if (managedScopeCouldOverride()) { printEndpointUnavailable(); return kOk; }
  const EndpointEnvProvider* pinned = endpointEnvProvider(expectedProvider);
  if (pinned == nullptr || envVar != pinned->envVar || !isSafeProviderId(expectedProvider) ||
      !isSafeModelId(expectedModel)) { printEndpointUnavailable(); return kOk; }

  bool profileExists = false;
  if (!plannedProfilePathIsSafeOrAbsent(configHome, profileHome, runId, profileExists)) {
    printEndpointUnavailable(); return kOk;
  }

  bool explicitPresent = false;
  const DotEnvValueState explicitState = readEndpointInputState(pinned->pinnedDefault, explicitPresent);
  if (explicitState == DotEnvValueState::Unsafe) { printEndpointUnavailable(); return kOk; }
  Selection selection;
  if (!readPosixConfig(configHome, selection)) {
    printEndpointUnavailable(); return kOk;
  }
  if (!selection.reason.empty() || selection.endpointOverride || selection.provider != expectedProvider ||
      selection.model != expectedModel) { printEndpointUnavailable(); return kOk; }

  const DotEnvValue profileValue = profileExists
    ? readPosixDotEnv(profileHome, true, envVar, pinned->pinnedDefault)
    : DotEnvValue{false, DotEnvValueState::Missing};
  const DotEnvValue projectValue = readPosixDotEnv(projectRoot, false, envVar, pinned->pinnedDefault);
  if (profileValue.state == DotEnvValueState::Unsafe || projectValue.state == DotEnvValueState::Unsafe ||
      profileValue.state == DotEnvValueState::Unsupported || projectValue.state == DotEnvValueState::Unsupported) {
    printEndpointUnavailable(); return kOk;
  }
  const DotEnvValueState effective = combineDotEnvPrecedence(profileValue, projectValue,
    explicitPresent, explicitState);
  if (effective != DotEnvValueState::Missing && effective != DotEnvValueState::Empty &&
      effective != DotEnvValueState::PinnedDefault) {
    printEndpointUnavailable(); return kOk;
  }
  printPinnedEndpoint(expectedProvider, envVar);
  return kOk;
}

#endif

enum class SourceCacheRelease { Token, Eof, Invalid };

SourceCacheRelease awaitSourceCacheRelease(const std::string& nonce) {
  std::cout << "SOURCE_CACHE_LOCK_READY\n" << std::flush;
  const std::string token = "RELEASE " + nonce + "\n";
  for (size_t index = 0; index < token.size(); ++index) {
    const int value = std::cin.get();
    if (value == EOF) return index == 0 && std::cin.eof() ? SourceCacheRelease::Eof : SourceCacheRelease::Invalid;
    if (value != token[index]) return SourceCacheRelease::Invalid;
  }
  return SourceCacheRelease::Token;
}

struct SourcePublisherIdentity { bool known; bool alive; std::string creation; };

bool validSourceCacheNonce(const std::string& nonce) {
  if (nonce.size() != 36) return false;
  for (size_t index = 0; index < nonce.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (nonce[index] != '-') return false;
    } else if (!((nonce[index] >= '0' && nonce[index] <= '9') || (nonce[index] >= 'a' && nonce[index] <= 'f'))) return false;
  }
  return true;
}

SourcePublisherIdentity sourcePublisherIdentity(uint32_t pid) {
#ifdef _WIN32
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (process == nullptr) return {GetLastError() == ERROR_INVALID_PARAMETER, false, ""};
  FILETIME creation{}, exit{}, kernel{}, user{};
  const DWORD state = WaitForSingleObject(process, 0);
  const bool known = GetProcessTimes(process, &creation, &exit, &kernel, &user) != 0;
  CloseHandle(process);
  if (!known || (state != WAIT_TIMEOUT && state != WAIT_OBJECT_0)) return {false, false, ""};
  const uint64_t timestamp = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  return {true, state == WAIT_TIMEOUT, std::to_string(timestamp)};
#else
  if (kill(static_cast<pid_t>(pid), 0) != 0 && errno == ESRCH) return {true, false, ""};
  std::ifstream input("/proc/" + std::to_string(pid) + "/stat");
  std::string line;
  if (!std::getline(input, line) || line.size() > 4096) return {false, false, ""};
  const size_t end = line.rfind(')');
  if (end == std::string::npos) return {false, false, ""};
  std::istringstream fields(line.substr(end + 1));
  std::string value, state;
  for (size_t index = 0; index < 20; ++index) {
    if (!(fields >> value)) return {false, false, ""};
    if (index == 0) state = value;
  }
  return {true, state != "Z" && state != "X", value};
#endif
}

bool sourceReservationCanBeAcquired(const std::string& reservation) {
  if (reservation.empty()) return true;
  std::istringstream input(reservation);
  unsigned version = 0;
  uint32_t pid = 0;
  std::string creation, nonce, extra;
  if (!(input >> version >> pid >> creation >> nonce) || version != 1 || pid == 0 || !validSourceCacheNonce(nonce) ||
      creation.empty() || creation.size() > 20 || creation.find_first_not_of("0123456789") != std::string::npos || (input >> extra) ||
      reservation != "1 " + std::to_string(pid) + " " + creation + " " + nonce + "\n") return false;
  const auto previous = sourcePublisherIdentity(pid);
  return previous.known && (!previous.alive || previous.creation != creation);
}

bool sourceCacheInputPending() {
#ifdef _WIN32
  DWORD bytes = 0;
  if (PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &bytes, nullptr)) return bytes != 0;
  const DWORD error = GetLastError();
  return error == ERROR_BROKEN_PIPE || error == ERROR_NO_DATA || error == ERROR_INVALID_HANDLE;
#else
  pollfd input{STDIN_FILENO, POLLIN | POLLHUP, 0};
  return poll(&input, 1, 0) > 0 && (input.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0;
#endif
}

// The file is permanent. Only the kernel releases authority on close/crash; no PID-based
// stale owner unlinks or replaces a path which another cooperating process might acquire.
int holdSourceCacheLock(const std::string& root, const std::string& publisherText, const std::string& nonce) {
  if (!validSourceCacheNonce(nonce)) return kInvalidInput;
  if (publisherText.empty() || publisherText.size() > 10 || publisherText.find_first_not_of("0123456789") != std::string::npos)
    return kInvalidInput;
  const uint64_t parsedPid = std::strtoull(publisherText.c_str(), nullptr, 10);
  if (parsedPid == 0 || parsedPid > 0x7fffffff) return kInvalidInput;
  const uint32_t publisher = static_cast<uint32_t>(parsedPid);
  const auto publisherIdentity = sourcePublisherIdentity(publisher);
  if (!publisherIdentity.known || !publisherIdentity.alive) return kPathUnsafe;
  const std::string reservation = "1 " + std::to_string(publisher) + " " + publisherIdentity.creation + " " + nonce + "\n";
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
#ifdef _WIN32
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return kPathUnsafe;
  HANDLE directory = openWindowsDirectory(widenUtf8(root), true, userSid, false, true, false, FILE_ADD_FILE);
  if (directory == INVALID_HANDLE_VALUE || !safePrivateDirectoryAcl(directory, userSid)) {
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
    return kPathUnsafe;
  }
  LPWSTR sidText = nullptr;
  if (!ConvertSidToStringSidW(userSid, &sidText)) { CloseHandle(directory); return kPathUnsafe; }
  const std::wstring sddl = std::wstring(L"O:") + sidText + L"D:P(A;;FA;;;" + sidText + L")";
  LocalFree(sidText);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
    CloseHandle(directory); return kPathUnsafe;
  }
  std::wstring name = L".source-cache.lock";
  UNICODE_STRING objectName{};
  objectName.Buffer = name.data();
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, directory, descriptor);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE file = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&file, GENERIC_READ | GENERIC_WRITE | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE,
    FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  LocalFree(descriptor);
  FILE_ATTRIBUTE_TAG_INFO attributesInfo{};
  FILE_STANDARD_INFO standard{};
  if (status < 0 || !getHandleAttributes(file, attributesInfo) ||
      (attributesInfo.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) ||
      standard.NumberOfLinks != 1 || !safePrivateDirectoryAcl(file, userSid)) {
    if (status >= 0) CloseHandle(file);
    CloseHandle(directory); return kPathUnsafe;
  }
  OVERLAPPED overlapped{};
  bool locked = false;
  bool cancelled = false;
  while (std::chrono::steady_clock::now() < deadline) {
    if (sourceCacheInputPending()) { cancelled = true; break; }
    if (LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)) { locked = true; break; }
    if (GetLastError() != ERROR_LOCK_VIOLATION) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  std::string previous;
  LARGE_INTEGER beginning{};
  std::array<char, 1025> bytes{};
  DWORD count = 0;
  const bool readable = locked && SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN) &&
    ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count <= 1024;
  if (readable) previous.assign(bytes.data(), count);
  const bool reserved = readable && sourceReservationCanBeAcquired(previous) && writeWindowsFile(file, reservation);
  const SourceCacheRelease release = reserved ? awaitSourceCacheRelease(nonce) : SourceCacheRelease::Invalid;
  const auto ownerAfter = sourcePublisherIdentity(publisher);
  const bool clear = release == SourceCacheRelease::Token ||
    (release == SourceCacheRelease::Eof && ownerAfter.known && (!ownerAfter.alive || ownerAfter.creation != publisherIdentity.creation));
  const bool released = reserved && release != SourceCacheRelease::Invalid && (!clear || writeWindowsFile(file, ""));
  if (locked) UnlockFileEx(file, 0, 1, 0, &overlapped);
  CloseHandle(file);
  CloseHandle(directory);
#else
  const int directory = openPosixDirectory(root, true);
  struct stat directoryInfo{};
  if (directory < 0 || fstat(directory, &directoryInfo) != 0 || (directoryInfo.st_mode & 0777) != 0700) {
    if (directory >= 0) close(directory);
    return kPathUnsafe;
  }
  const int file = openat(directory, ".source-cache.lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  struct stat info{};
  if (file < 0 || fstat(file, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
      (info.st_mode & 0777) != 0600 || info.st_nlink != 1) {
    if (file >= 0) close(file);
    close(directory); return kPathUnsafe;
  }
  bool locked = false;
  bool cancelled = false;
  while (std::chrono::steady_clock::now() < deadline) {
    if (sourceCacheInputPending()) { cancelled = true; break; }
    if (flock(file, LOCK_EX | LOCK_NB) == 0) { locked = true; break; }
    if (errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  struct stat current{};
  const bool sameFile = fstatat(directory, ".source-cache.lock", &current, AT_SYMLINK_NOFOLLOW) == 0 &&
    current.st_dev == info.st_dev && current.st_ino == info.st_ino && S_ISREG(current.st_mode) && current.st_nlink == 1;
  std::array<char, 1025> bytes{};
  const ssize_t count = locked && sameFile ? pread(file, bytes.data(), bytes.size(), 0) : -1;
  const bool readable = count >= 0 && count <= 1024;
  const std::string previous = readable ? std::string(bytes.data(), static_cast<size_t>(count)) : "";
  const bool reserved = readable && sourceReservationCanBeAcquired(previous) &&
    pwrite(file, reservation.data(), reservation.size(), 0) == static_cast<ssize_t>(reservation.size()) &&
    ftruncate(file, static_cast<off_t>(reservation.size())) == 0 && fsync(file) == 0;
  const SourceCacheRelease release = reserved ? awaitSourceCacheRelease(nonce) : SourceCacheRelease::Invalid;
  const auto ownerAfter = sourcePublisherIdentity(publisher);
  const bool clear = release == SourceCacheRelease::Token ||
    (release == SourceCacheRelease::Eof && ownerAfter.known && (!ownerAfter.alive || ownerAfter.creation != publisherIdentity.creation));
  const bool released = reserved && release != SourceCacheRelease::Invalid && (!clear || (ftruncate(file, 0) == 0 && fsync(file) == 0));
  if (locked) flock(file, LOCK_UN);
  close(file);
  close(directory);
#endif
  return released || cancelled ? kOk : kPathUnsafe;
}

// Shared run/preflight references are independent from publication authority. Kernel ownership is
// sufficient here: the helper process itself is the lease and process death releases it.
int holdSourceCacheReferenceLock(const std::string& root, const std::string& mode, const std::string& nonce) {
  if ((mode != "shared" && mode != "exclusive") || !validSourceCacheNonce(nonce)) return kInvalidInput;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
#ifdef _WIN32
  std::vector<unsigned char> sidStorage;
  PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return kPathUnsafe;
  HANDLE directory = openWindowsDirectory(widenUtf8(root), true, userSid, false, true, false, FILE_ADD_FILE);
  if (directory == INVALID_HANDLE_VALUE || !safePrivateDirectoryAcl(directory, userSid)) {
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
    return kPathUnsafe;
  }
  LPWSTR sidText = nullptr;
  if (!ConvertSidToStringSidW(userSid, &sidText)) { CloseHandle(directory); return kPathUnsafe; }
  const std::wstring sddl = std::wstring(L"O:") + sidText + L"D:P(A;;FA;;;" + sidText + L")";
  LocalFree(sidText);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
    CloseHandle(directory); return kPathUnsafe;
  }
  std::wstring name = L".source-cache.ref.lock";
  UNICODE_STRING objectName{};
  objectName.Buffer = name.data();
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, directory, descriptor);
  IO_STATUS_BLOCK ioStatus{};
  HANDLE file = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&file, GENERIC_READ | GENERIC_WRITE | READ_CONTROL | SYNCHRONIZE,
    &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE,
    FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  LocalFree(descriptor);
  FILE_ATTRIBUTE_TAG_INFO attributesInfo{};
  FILE_STANDARD_INFO standard{};
  if (status < 0 || !getHandleAttributes(file, attributesInfo) ||
      (attributesInfo.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) ||
      standard.NumberOfLinks != 1 || !safePrivateDirectoryAcl(file, userSid)) {
    if (status >= 0) CloseHandle(file);
    CloseHandle(directory); return kPathUnsafe;
  }
  OVERLAPPED overlapped{};
  bool locked = false;
  bool cancelled = false;
  while (std::chrono::steady_clock::now() < deadline) {
    if (sourceCacheInputPending()) { cancelled = true; break; }
    const DWORD flags = (mode == "exclusive" ? LOCKFILE_EXCLUSIVE_LOCK : 0) | LOCKFILE_FAIL_IMMEDIATELY;
    if (LockFileEx(file, flags, 0, 1, 0, &overlapped)) { locked = true; break; }
    if (GetLastError() != ERROR_LOCK_VIOLATION) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  // NtCreateFile was anchored to the already ACL-verified directory with OBJ_DONT_REPARSE.
  const bool sameFile = locked;
  const SourceCacheRelease release = sameFile ? awaitSourceCacheRelease(nonce) : SourceCacheRelease::Invalid;
  if (locked) UnlockFileEx(file, 0, 1, 0, &overlapped);
  CloseHandle(file);
  CloseHandle(directory);
  return cancelled || release == SourceCacheRelease::Token || release == SourceCacheRelease::Eof ? kOk : kPathUnsafe;
#else
  const int directory = openPosixDirectory(root, true);
  struct stat directoryInfo{};
  if (directory < 0 || fstat(directory, &directoryInfo) != 0 || (directoryInfo.st_mode & 0777) != 0700) {
    if (directory >= 0) close(directory);
    return kPathUnsafe;
  }
  const int file = openat(directory, ".source-cache.ref.lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  struct stat info{};
  if (file < 0 || fstat(file, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
      (info.st_mode & 0777) != 0600 || info.st_nlink != 1) {
    if (file >= 0) close(file);
    close(directory); return kPathUnsafe;
  }
  bool locked = false;
  bool cancelled = false;
  while (std::chrono::steady_clock::now() < deadline) {
    if (sourceCacheInputPending()) { cancelled = true; break; }
    const int operation = mode == "exclusive" ? LOCK_EX : LOCK_SH;
    if (flock(file, operation | LOCK_NB) == 0) { locked = true; break; }
    if (errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  struct stat current{};
  const bool sameFile = locked && fstatat(directory, ".source-cache.ref.lock", &current, AT_SYMLINK_NOFOLLOW) == 0 &&
    current.st_dev == info.st_dev && current.st_ino == info.st_ino && S_ISREG(current.st_mode) && current.st_nlink == 1;
  const SourceCacheRelease release = sameFile ? awaitSourceCacheRelease(nonce) : SourceCacheRelease::Invalid;
  if (locked) flock(file, LOCK_UN);
  close(file);
  close(directory);
  return cancelled || release == SourceCacheRelease::Token || release == SourceCacheRelease::Eof ? kOk : kPathUnsafe;
#endif
}

struct SnapshotGcObject { std::string kind, dev, ino, path; };

bool splitSnapshotGcLine(const std::string& line, std::vector<std::string>& fields) {
  fields.clear(); size_t start = 0;
  for (;;) { const size_t end = line.find('\t', start); fields.push_back(line.substr(start, end == std::string::npos ? end : end - start));
    if (end == std::string::npos) break; start = end + 1; }
  return true;
}

bool exactUnsigned(const std::string& value) {
  return !value.empty() && value.size() <= 24 && value.find_first_not_of("0123456789") == std::string::npos &&
    (value.size() == 1 || value.front() != '0');
}

bool validSnapshotGcPath(const std::string& kind, const std::string& path, const std::string& directoryId) {
  if (path.empty() || path.size() > 720 || path.front() == '/' || path.find('\\') != std::string::npos) return false;
#ifdef _WIN32
  const std::wstring widePath = widenUtf8(path);
  if (widePath.empty() || widePath.size() > 240) return false;
#endif
  if (kind == "sidecar") return path == directoryId + ".manifest.json" || path == directoryId + ".native-v1.bin" ||
    path == ".gc-" + directoryId + ".intent.json";
  size_t start = 0;
  for (;;) {
    const size_t end = path.find('/', start);
    const std::string part = path.substr(start, end == std::string::npos ? end : end - start);
    if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ' ||
        part.find_first_of("<>:\"|?*") != std::string::npos ||
        std::any_of(part.begin(), part.end(), [](unsigned char value) { return value < 0x20; })) return false;
#ifdef _WIN32
    const std::wstring widePart = widenUtf8(part);
    if (widePart.empty() || widePart.size() > 255) return false;
#else
    if (part.size() > 255) return false;
#endif
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

#ifndef _WIN32
bool samePosixIdentity(const struct stat& info, const SnapshotGcObject& expected) {
  return std::to_string(static_cast<uint64_t>(info.st_dev)) == expected.dev &&
    std::to_string(static_cast<uint64_t>(info.st_ino)) == expected.ino;
}

bool removePosixGcObject(int cache, int root, const SnapshotGcObject& object) {
  const bool rootObject = object.kind == "root";
  const bool sidecar = object.kind == "sidecar";
  if (!sidecar && !rootObject && root < 0) return true;
  int parent = dup(sidecar || rootObject ? cache : root);
  if (parent < 0) return false;
  std::string leaf;
  if (rootObject) leaf = object.path;
  else if (sidecar) leaf = object.path;
  else {
    size_t start = 0;
    for (;;) {
      const size_t end = object.path.find('/', start);
      if (end == std::string::npos) { leaf = object.path.substr(start); break; }
      const std::string component = object.path.substr(start, end - start);
      const int child = openat(parent, component.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat opened{};
      if (child < 0 && errno == ENOENT) { close(parent); return true; }
      if (child < 0 || fstat(child, &opened) != 0 || !S_ISDIR(opened.st_mode)) { if (child >= 0) close(child); close(parent); return false; }
      close(parent); parent = child; start = end + 1;
    }
  }
  struct stat before{};
  if (fstatat(parent, leaf.c_str(), &before, AT_SYMLINK_NOFOLLOW) != 0) {
    const bool absent = errno == ENOENT; close(parent); return absent;
  }
  if ((rootObject || object.kind == "directory") ? !S_ISDIR(before.st_mode) : !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode)) { close(parent); return false; }
  if (!samePosixIdentity(before, object)) { close(parent); return false; }
  if (S_ISDIR(before.st_mode)) {
    if ((before.st_mode & 0777) != 0700) { close(parent); return false; }
    const int handle = openat(parent, leaf.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat held{}, current{};
    const bool verified = handle >= 0 && fstat(handle, &held) == 0 && samePosixIdentity(held, object) &&
      (held.st_mode & 0777) == 0700 && fstatat(parent, leaf.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      samePosixIdentity(current, object) && (current.st_mode & 0777) == 0700;
    if (handle >= 0) close(handle);
    if (!verified || fstatat(parent, leaf.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0 ||
        !samePosixIdentity(current, object) || (current.st_mode & 0777) != 0700) { close(parent); return false; }
    const bool removed = unlinkat(parent, leaf.c_str(), AT_REMOVEDIR) == 0 && fsync(parent) == 0; close(parent); return removed;
  }
  const int handle = openat(parent, leaf.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  struct stat held{}, current{};
  const bool verified = handle >= 0 && fstat(handle, &held) == 0 && S_ISREG(held.st_mode) && samePosixIdentity(held, object) &&
    fstatat(parent, leaf.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 && samePosixIdentity(current, object);
  if (handle >= 0) close(handle);
  if (!verified || fstatat(parent, leaf.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0 || !samePosixIdentity(current, object)) { close(parent); return false; }
  const bool removed = unlinkat(parent, leaf.c_str(), 0) == 0 && fsync(parent) == 0; close(parent); return removed;
}

bool posixGcDirectoryModeIsRecoverable(mode_t mode) {
  const mode_t permissions = mode & 0777;
  return permissions == 0500 || permissions == 0700;
}

bool preparePosixGcDirectory(int parent, const std::string& name, const SnapshotGcObject& expected) {
  struct stat named{};
  if (fstatat(parent, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT;
  if (!S_ISDIR(named.st_mode) || S_ISLNK(named.st_mode) || !samePosixIdentity(named, expected) ||
      !posixGcDirectoryModeIsRecoverable(named.st_mode)) return false;
  const int handle = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat held{}, current{};
  bool verified = handle >= 0 && fstat(handle, &held) == 0 && S_ISDIR(held.st_mode) &&
    samePosixIdentity(held, expected) && posixGcDirectoryModeIsRecoverable(held.st_mode) &&
    fstatat(parent, name.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISDIR(current.st_mode) && samePosixIdentity(current, expected) && posixGcDirectoryModeIsRecoverable(current.st_mode);
  if (verified && (held.st_mode & 0777) == 0500) verified = fchmod(handle, 0700) == 0;
  if (verified) {
    verified = fstat(handle, &held) == 0 && S_ISDIR(held.st_mode) && samePosixIdentity(held, expected) &&
      (held.st_mode & 0777) == 0700 && fstatat(parent, name.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISDIR(current.st_mode) && samePosixIdentity(current, expected) && (current.st_mode & 0777) == 0700 &&
      fsync(handle) == 0 && fsync(parent) == 0;
  }
  if (handle >= 0) close(handle);
  return verified;
}

bool preparePosixGcTreeDirectories(int cache, int root, const std::string& directoryId,
                                   const SnapshotGcObject& expectedRoot,
                                   const std::map<std::string, SnapshotGcObject>& expectedNodes) {
  if (!preparePosixGcDirectory(cache, directoryId, expectedRoot)) return false;
  std::vector<SnapshotGcObject> directories;
  for (const auto& [_, node] : expectedNodes) if (node.kind == "directory") directories.push_back(node);
  std::stable_sort(directories.begin(), directories.end(), [](const SnapshotGcObject& left, const SnapshotGcObject& right) {
    const auto depth = [](const std::string& path) { return static_cast<size_t>(std::count(path.begin(), path.end(), '/')); };
    return depth(left.path) < depth(right.path);
  });
  for (const auto& directory : directories) {
    int parent = dup(root);
    if (parent < 0) return false;
    size_t start = 0;
    bool absentAncestor = false;
    for (;;) {
      const size_t end = directory.path.find('/', start);
      if (end == std::string::npos) {
        const bool prepared = absentAncestor || preparePosixGcDirectory(parent, directory.path.substr(start), directory);
        close(parent);
        if (!prepared) return false;
        break;
      }
      const std::string component = directory.path.substr(start, end - start);
      const std::string ancestorPath = directory.path.substr(0, end);
      const auto expectedAncestor = expectedNodes.find(ancestorPath);
      if (expectedAncestor == expectedNodes.end() || expectedAncestor->second.kind != "directory") { close(parent); return false; }
      struct stat named{};
      if (fstatat(parent, component.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT) { absentAncestor = true; close(parent); break; }
        close(parent); return false;
      }
      const int child = openat(parent, component.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat held{};
      const bool valid = child >= 0 && fstat(child, &held) == 0 && S_ISDIR(held.st_mode) &&
        samePosixIdentity(held, expectedAncestor->second) && posixGcDirectoryModeIsRecoverable(held.st_mode) &&
        S_ISDIR(named.st_mode) && samePosixIdentity(named, expectedAncestor->second) &&
        posixGcDirectoryModeIsRecoverable(named.st_mode);
      if (child >= 0) close(parent);
      if (!valid) { if (child >= 0) close(child); else close(parent); return false; }
      parent = child;
      start = end + 1;
    }
    if (absentAncestor) continue;
  }
  return true;
}

bool preflightPosixGcDirectory(int directory, const std::string& prefix,
                               const std::map<std::string, SnapshotGcObject>& expected,
                               std::set<std::string>& seen) {
  const int duplicate = dup(directory);
  if (duplicate < 0) return false;
  DIR* stream = fdopendir(duplicate);
  if (stream == nullptr) { close(duplicate); return false; }
  bool safe = true;
  while (safe) {
    errno = 0; const dirent* entry = readdir(stream);
    if (entry == nullptr) { safe = errno == 0; break; }
    const std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    const std::string path = prefix.empty() ? name : prefix + "/" + name;
    const auto found = expected.find(path);
    if (found == expected.end() || !seen.insert(path).second) { safe = false; break; }
    struct stat named{};
    if (fstatat(directory, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 || S_ISLNK(named.st_mode) ||
        (found->second.kind == "directory" ? (!S_ISDIR(named.st_mode) || !posixGcDirectoryModeIsRecoverable(named.st_mode)) : !S_ISREG(named.st_mode)) ||
        !samePosixIdentity(named, found->second)) { safe = false; break; }
    if (found->second.kind == "directory") {
      const int child = openat(directory, name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat held{};
      if (child < 0 || fstat(child, &held) != 0 || !samePosixIdentity(held, found->second) ||
          !posixGcDirectoryModeIsRecoverable(held.st_mode) ||
          !preflightPosixGcDirectory(child, path, expected, seen)) safe = false;
      if (child >= 0) close(child);
    } else {
      const int child = openat(directory, name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
      struct stat held{};
      if (child < 0 || fstat(child, &held) != 0 || !S_ISREG(held.st_mode) || !samePosixIdentity(held, found->second)) safe = false;
      if (child >= 0) close(child);
    }
  }
  closedir(stream);
  return safe;
}

bool preflightPosixGcSidecars(int cache, const std::string& directoryId,
                              const std::map<std::string, SnapshotGcObject>& sidecars,
                              bool& metadataPresent, bool& projectionPresent) {
  const std::array<std::string, 3> names = {directoryId + ".manifest.json", directoryId + ".native-v1.bin",
    ".gc-" + directoryId + ".intent.json"};
  for (size_t index = 0; index < names.size(); ++index) {
    const auto& name = names[index];
    struct stat named{};
    const auto expected = sidecars.find(name);
    if (fstatat(cache, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT && expected == sidecars.end() && name != names.back()) continue;
      return false;
    }
    if (expected == sidecars.end() || !S_ISREG(named.st_mode) || S_ISLNK(named.st_mode) ||
        !samePosixIdentity(named, expected->second)) return false;
    const int handle = openat(cache, name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    struct stat held{};
    const bool verified = handle >= 0 && fstat(handle, &held) == 0 && S_ISREG(held.st_mode) &&
      samePosixIdentity(held, expected->second);
    if (handle >= 0) close(handle);
    if (!verified) return false;
    if (index == 0) metadataPresent = true;
    if (index == 1) projectionPresent = true;
  }
  return true;
}
#endif

// Plan20 §5B: the cache is not an OS sandbox. The held EX leases serialize Orchestrator work;
// descriptor-relative no-follow identity checks protect normal publication/update/cleanup races.
// Deliberately hostile same-UID processes are outside this guarantee.
int removeSnapshotGcTree(const std::string& cacheRoot, const std::string& directoryId) {
  constexpr size_t kGcIntentAndInventoryBytes = 64 * 1024 * 1024;
  constexpr size_t kGcNodeLimit = 200000;
  constexpr size_t kGcAggregatePathBytes = 8 * 1024 * 1024;
  if (directoryId.size() != 64 || directoryId.find_first_not_of("0123456789abcdef") != std::string::npos) return kInvalidInput;
  std::vector<SnapshotGcObject> objects; std::set<std::string> paths; std::string line; size_t bytes = 0;
  size_t pathBytes = 0; size_t sourceNodes = 0; size_t sourceFiles = 0; size_t sourceDirectories = 0; bool header = false;
  while (std::getline(std::cin, line)) {
    bytes += line.size() + 1; if (bytes > kGcIntentAndInventoryBytes || objects.size() > kGcNodeLimit + 4) return kInvalidInput;
    std::vector<std::string> fields; splitSnapshotGcLine(line, fields);
    if (!header) {
      if (fields.size() != 3 || fields[0] != "ROOT" || !exactUnsigned(fields[1]) || !exactUnsigned(fields[2])) return kInvalidInput;
      objects.push_back({"root", fields[1], fields[2], directoryId}); header = true; continue;
    }
    if (fields.size() != 4 || (fields[0] != "file" && fields[0] != "directory" && fields[0] != "sidecar") ||
        !exactUnsigned(fields[1]) || !exactUnsigned(fields[2]) || !validSnapshotGcPath(fields[0], fields[3], directoryId) ||
        !paths.insert(fields[3]).second) return kInvalidInput;
    if (fields[0] == "sidecar") {
      if (paths.size() > kGcNodeLimit + 3) return kInvalidInput;
    } else {
      ++sourceNodes;
      if (fields[0] == "file") ++sourceFiles; else ++sourceDirectories;
      pathBytes += fields[3].size();
      if (sourceNodes > kGcNodeLimit || sourceFiles > 100000 || sourceDirectories > 100000 ||
          pathBytes > kGcAggregatePathBytes) return kInvalidInput;
    }
    objects.push_back({fields[0], fields[1], fields[2], fields[3]});
  }
  if (!header || !std::cin.eof() || paths.find(".gc-" + directoryId + ".intent.json") == paths.end()) return kInvalidInput;
  std::map<std::string, SnapshotGcObject> expectedNodes, sidecars;
  for (size_t i = 1; i < objects.size(); ++i) {
    if (objects[i].kind == "sidecar") sidecars.emplace(objects[i].path, objects[i]);
    else expectedNodes.emplace(objects[i].path, objects[i]);
  }
  bool metadataPresent = false, projectionPresent = false;
#ifdef _WIN32
  std::vector<unsigned char> sidStorage; PSID userSid = nullptr;
  if (!getCurrentUserSid(sidStorage, userSid)) return kPathUnsafe;
  HANDLE cache = openWindowsDirectory(widenUtf8(cacheRoot), true, userSid, false, true, false, FILE_LIST_DIRECTORY);
  if (cache == INVALID_HANDLE_VALUE) return kPathRootOpenFailed;
  auto verify = [](HANDLE handle, const SnapshotGcObject& expected) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info)) return false;
    const uint64_t index = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
    return std::to_string(info.dwVolumeSerialNumber) == expected.dev && std::to_string(index) == expected.ino;
  };
  const auto openDirectory = [](HANDLE parent, const std::wstring& name) {
    return openWindowsChildDirectory(parent, name, FILE_OPEN, nullptr, false, false,
      DELETE | FILE_LIST_DIRECTORY | FILE_WRITE_ATTRIBUTES, false);
  };
  const auto openFile = [](HANDLE parent, const std::wstring& name) {
    UNICODE_STRING objectName{}; objectName.Buffer = const_cast<PWSTR>(name.c_str());
    objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t)); objectName.MaximumLength = objectName.Length;
    OBJECT_ATTRIBUTES attributes{}; InitializeObjectAttributes(&attributes, &objectName, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, nullptr);
    IO_STATUS_BLOCK ioStatus{}; HANDLE handle = INVALID_HANDLE_VALUE;
    const NTSTATUS status = NtCreateFile(&handle, DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE,
      &attributes, &ioStatus, nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE,
      FILE_OPEN, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
    FILE_ATTRIBUTE_TAG_INFO tag{};
    if (status < 0 || !getHandleAttributes(handle, tag) ||
        (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
      if (status >= 0) CloseHandle(handle); return INVALID_HANDLE_VALUE;
    }
    return handle;
  };
  const auto removeHandle = [&](HANDLE handle, const SnapshotGcObject& expected, bool directory) {
    FILE_ATTRIBUTE_TAG_INFO tag{};
    if (!verify(handle, expected) || !getHandleAttributes(handle, tag) ||
        (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        (((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory)) return false;
    FILE_BASIC_INFO basic{};
    if (!GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))) return false;
    basic.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;
    if (!SetFileInformationByHandle(handle, FileBasicInfo, &basic, sizeof(basic))) return false;
    FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
    return SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition)) != 0;
  };
  std::set<std::string> seen;
  const auto preflightDirectory = [&](auto&& self, HANDLE directory, const std::string& prefix) -> bool {
    std::vector<unsigned char> buffer(64 * 1024);
    bool restart = true;
    for (;;) {
      const auto infoClass = restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo;
      restart = false;
      if (!GetFileInformationByHandleEx(directory, infoClass, buffer.data(), static_cast<DWORD>(buffer.size()))) {
        return GetLastError() == ERROR_NO_MORE_FILES;
      }
      auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
      for (;;) {
        const std::wstring wideName(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
        const std::string name = narrowUtf8(wideName);
        if (name != "." && name != "..") {
          const std::string path = prefix.empty() ? name : prefix + "/" + name;
          const auto found = expectedNodes.find(path);
          if (found == expectedNodes.end() || !seen.insert(path).second) return false;
          HANDLE child = found->second.kind == "directory" ? openDirectory(directory, wideName) : openFile(directory, wideName);
          if (child == INVALID_HANDLE_VALUE || !verify(child, found->second)) { if (child != INVALID_HANDLE_VALUE) CloseHandle(child); return false; }
          const bool valid = found->second.kind != "directory" || self(self, child, path);
          CloseHandle(child);
          if (!valid) return false;
        }
        if (entry->NextEntryOffset == 0) break;
        entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<unsigned char*>(entry) + entry->NextEntryOffset);
      }
    }
  };
  const auto preflightSidecars = [&]() {
    const std::array<std::string, 3> names = {directoryId + ".manifest.json", directoryId + ".native-v1.bin",
      ".gc-" + directoryId + ".intent.json"};
    for (size_t i = 0; i < names.size(); ++i) {
      const std::wstring name = widenUtf8(names[i]);
      HANDLE handle = openFile(cache, name);
      if (handle == INVALID_HANDLE_VALUE) {
        if (windowsChildDoesNotExist(cache, name) && i < 2 && sidecars.find(names[i]) == sidecars.end()) continue;
        return false;
      }
      const auto expected = sidecars.find(names[i]);
      const bool valid = expected != sidecars.end() && verify(handle, expected->second);
      CloseHandle(handle);
      if (!valid) return false;
      if (i == 0) metadataPresent = true;
      if (i == 1) projectionPresent = true;
    }
    return true;
  };
  std::vector<SnapshotGcObject> nodes;
  for (const auto& [_, object] : expectedNodes) nodes.push_back(object);
  std::stable_sort(nodes.begin(), nodes.end(), [](const SnapshotGcObject& a, const SnapshotGcObject& b) {
    const auto depth = [](const std::string& value) { return static_cast<size_t>(std::count(value.begin(), value.end(), '/')); };
    return depth(a.path) > depth(b.path);
  });
  bool ok = true;
  const std::wstring rootName = widenUtf8(directoryId);
  HANDLE rootHandle = openDirectory(cache, rootName);
  const bool rootAbsent = rootHandle == INVALID_HANDLE_VALUE && windowsChildDoesNotExist(cache, rootName);
  int failureCode = kPathIdentityUnavailable;
  if (rootHandle == INVALID_HANDLE_VALUE && !rootAbsent) { ok = false; failureCode = kPathRootUnsafe; }
  if (ok && !rootAbsent && !verify(rootHandle, objects.front())) { ok = false; failureCode = kPathRootUnsafe; }
  if (ok && !rootAbsent && !preflightDirectory(preflightDirectory, rootHandle, "")) { ok = false; failureCode = kPathComponentUnsafe; }
  if (ok && !preflightSidecars()) { ok = false; failureCode = kPathComponentUnsafe; }
  if (ok && ((!rootAbsent && (!metadataPresent || !projectionPresent)) ||
      (rootAbsent && metadataPresent && !projectionPresent))) { ok = false; failureCode = kPathComponentUnsafe; }
  if (!ok) { if (rootHandle != INVALID_HANDLE_VALUE) CloseHandle(rootHandle); CloseHandle(cache); return failureCode; }
  for (const auto& object : nodes) {
    if (rootAbsent) continue;
    HANDLE parent = rootHandle;
    if (parent == INVALID_HANDLE_VALUE) { ok = false; failureCode = kPathRootOpenFailed; break; }
    std::string leaf = object.path;
    bool missingAncestor = false;
    size_t start = 0;
    for (;;) {
      const size_t end = object.path.find('/', start);
      if (end == std::string::npos) { leaf = object.path.substr(start); break; }
      const std::wstring component = widenUtf8(object.path.substr(start, end - start));
      HANDLE next = openDirectory(parent, component);
      if (next == INVALID_HANDLE_VALUE && windowsChildDoesNotExist(parent, component)) missingAncestor = true;
      if (parent != rootHandle) CloseHandle(parent);
      if (missingAncestor) { parent = INVALID_HANDLE_VALUE; break; }
      if (next == INVALID_HANDLE_VALUE) { parent = INVALID_HANDLE_VALUE; break; }
      parent = next; start = end + 1;
    }
    if (missingAncestor) continue;
    if (parent == INVALID_HANDLE_VALUE) { ok = false; failureCode = kPathComponentOpenFailed; break; }
    HANDLE target = object.kind == "directory" ? openDirectory(parent, widenUtf8(leaf)) : openFile(parent, widenUtf8(leaf));
    const bool absent = target == INVALID_HANDLE_VALUE && windowsChildDoesNotExist(parent, widenUtf8(leaf));
    const bool deleted = target != INVALID_HANDLE_VALUE && removeHandle(target, object, object.kind == "directory");
    if (target != INVALID_HANDLE_VALUE) CloseHandle(target);
    if (parent != rootHandle) CloseHandle(parent);
    if (!deleted && !absent) { ok = false; failureCode = kPathComponentUnsafe; break; }
  }
  if (ok && !rootAbsent) {
    ok = removeHandle(rootHandle, objects.front(), true);
  }
  if (rootHandle != INVALID_HANDLE_VALUE) CloseHandle(rootHandle);
  if (ok) {
    const std::array<std::string, 3> names = {directoryId + ".manifest.json", directoryId + ".native-v1.bin",
      ".gc-" + directoryId + ".intent.json"};
    for (const auto& name : names) {
      const auto expected = sidecars.find(name);
      if (expected == sidecars.end()) continue;
      HANDLE handle = openFile(cache, widenUtf8(name));
      if (handle == INVALID_HANDLE_VALUE) { if (windowsChildDoesNotExist(cache, widenUtf8(name))) continue; ok = false; break; }
      const bool deleted = removeHandle(handle, expected->second, false); CloseHandle(handle);
      if (!deleted) { ok = false; break; }
    }
  }
  CloseHandle(cache); return ok ? kOk : failureCode;
#else
  const int cache = openAbsoluteDirectory(cacheRoot, true);
  struct stat cacheInfo{};
  if (cache < 0 || fstat(cache, &cacheInfo) != 0 || (cacheInfo.st_mode & 0777) != 0700) { if (cache >= 0) close(cache); return kPathUnsafe; }
  struct stat rootInfo{};
  const int root = openat(cache, directoryId.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  const bool rootAbsent = root < 0 && errno == ENOENT;
  if ((!rootAbsent && root < 0) || (root >= 0 && (fstat(root, &rootInfo) != 0 ||
      !S_ISDIR(rootInfo.st_mode) || !samePosixIdentity(rootInfo, objects.front()) ||
      !posixGcDirectoryModeIsRecoverable(rootInfo.st_mode)))) { if (root >= 0) close(root); close(cache); return kPathUnsafe; }
  std::set<std::string> seen;
  if (!rootAbsent && !preflightPosixGcDirectory(root, "", expectedNodes, seen)) { close(root); close(cache); return kPathUnsafe; }
  if (!preflightPosixGcSidecars(cache, directoryId, sidecars, metadataPresent, projectionPresent) ||
      ((!rootAbsent && (!metadataPresent || !projectionPresent)) ||
       (rootAbsent && metadataPresent && !projectionPresent))) {
    if (root >= 0) close(root); close(cache); return kPathUnsafe;
  }
  if (!rootAbsent && !preparePosixGcTreeDirectories(cache, root, directoryId, objects.front(), expectedNodes)) {
    close(root); close(cache); return kPathUnsafe;
  }
  std::vector<SnapshotGcObject> nodes;
  for (const auto& [_, object] : expectedNodes) nodes.push_back(object);
  std::stable_sort(nodes.begin(), nodes.end(), [](const SnapshotGcObject& a, const SnapshotGcObject& b) {
    const auto depth = [](const std::string& value) { return static_cast<size_t>(std::count(value.begin(), value.end(), '/')); };
    return depth(a.path) > depth(b.path);
  });
  bool ok = true;
  for (const auto& object : nodes) { if (!removePosixGcObject(cache, root, object)) { ok = false; break; } }
  if (root >= 0) close(root);
  if (ok && !rootAbsent) ok = removePosixGcObject(cache, cache, objects.front());
  if (ok) {
    const std::array<std::string, 3> names = {directoryId + ".manifest.json", directoryId + ".native-v1.bin",
      ".gc-" + directoryId + ".intent.json"};
    for (const auto& name : names) {
      const auto expected = sidecars.find(name);
      if (expected == sidecars.end()) continue;
      if (!removePosixGcObject(cache, cache, expected->second)) { ok = false; break; }
    }
  }
  close(cache); return ok ? kOk : kPathUnsafe;
#endif
}

int cleanupProfile(const std::string& root, const std::string& runId) {
  if (!isSafeRunId(runId)) return kInvalidInput;
#ifdef _WIN32
  return cleanupWindowsProfile(root, runId);
#else
  return cleanupPosixProfile(root, runId);
#endif
}

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  if (argc == 5 && argv[1] != nullptr && argv[2] != nullptr && argv[3] != nullptr && argv[4] != nullptr && argv[1] == std::wstring(L"source-cache-lock")) {
    return holdSourceCacheLock(narrowUtf8(argv[2]), narrowUtf8(argv[3]), narrowUtf8(argv[4]));
  }
  if (argc == 5 && argv[1] != nullptr && argv[2] != nullptr && argv[3] != nullptr && argv[4] != nullptr && argv[1] == std::wstring(L"source-cache-reference-lock")) {
    return holdSourceCacheReferenceLock(narrowUtf8(argv[2]), narrowUtf8(argv[3]), narrowUtf8(argv[4]));
  }
  if (argc == 4 && argv[1] != nullptr && argv[2] != nullptr && argv[3] != nullptr && argv[1] == std::wstring(L"source-cache-gc-remove")) {
    return removeSnapshotGcTree(narrowUtf8(argv[2]), narrowUtf8(argv[3]));
  }
  if (argc == 4 && argv[1] != nullptr && argv[2] != nullptr && argv[3] != nullptr && argv[1] == std::wstring(L"create-profile")) {
    const std::string root = narrowUtf8(argv[2]);
    const std::string runId = narrowUtf8(argv[3]);
    if (root.empty() || runId.empty()) return kInvalidInput;
    return createProfile(root, runId);
  }
  if (argc == 4 && argv[1] != nullptr && argv[2] != nullptr && argv[3] != nullptr && argv[1] == std::wstring(L"cleanup-profile")) {
    const std::string root = narrowUtf8(argv[2]);
    const std::string runId = narrowUtf8(argv[3]);
    if (root.empty() || runId.empty()) return kInvalidInput;
    return cleanupProfile(root, runId);
  }
  if (argc == 4 && argv[1] != nullptr && argv[2] != nullptr && argv[3] != nullptr && argv[1] == std::wstring(L"initialize-run-profile")) {
    const std::string root = narrowUtf8(argv[2]);
    const std::string runId = narrowUtf8(argv[3]);
    std::string configYaml;
    if (root.empty() || runId.empty() || !readWindowsRunProfileConfig(configYaml)) return kInvalidInput;
    return initializeWindowsRunProfile(root, runId, configYaml) ? kOk : kPathCreateFailed;
  }
  if (argc == 5 && argv[1] != nullptr && argv[2] != nullptr && argv[3] != nullptr && argv[4] != nullptr &&
      argv[1] == std::wstring(L"project-selection")) {
    const std::string home = narrowUtf8(argv[2]);
    const std::string profileHome = narrowUtf8(argv[3]);
    const std::string runId = narrowUtf8(argv[4]);
    if (home.empty() || profileHome.empty() || runId.empty()) return kInvalidInput;
    return projectSelection(home, profileHome, runId);
  }
  if (argc == 9 && argv[1] != nullptr && argv[1] == std::wstring(L"project-endpoint")) {
    const std::string configHome = narrowUtf8(argv[2]);
    const std::string profileHome = narrowUtf8(argv[3]);
    const std::string projectRoot = narrowUtf8(argv[4]);
    const std::string provider = narrowUtf8(argv[5]);
    const std::string model = narrowUtf8(argv[6]);
    const std::string envVar = narrowUtf8(argv[7]);
    const std::string runId = narrowUtf8(argv[8]);
    if (configHome.empty() || profileHome.empty() || projectRoot.empty() || provider.empty() || model.empty() || envVar.empty() || runId.empty())
      return kInvalidInput;
    return projectEndpoint(configHome, profileHome, projectRoot, provider, model, envVar, runId);
  }
  if (argc == 4 && argv[1] != nullptr && argv[1] == std::wstring(L"verify-safe-path")) {
    return verifySafeWindowsPath(argv[3], argv[2]);
  }
  if (argc == 5 && argv[1] != nullptr && argv[1] == std::wstring(L"verify-safe-path-chain")) {
    return verifySafeWindowsPathChain(argv[3], argv[2], argv[4]);
  }
  if (argc == 4 && argv[1] != nullptr && argv[1] == std::wstring(L"verify-safe-file-chain")) {
    return verifySafeWindowsFilePathChain(argv[2], argv[3]);
  }
  return kInvalidInput;
}
#else
int main(int argc, char** argv) {
  if (argc == 5 && std::string(argv[1]) == "source-cache-lock") return holdSourceCacheLock(argv[2], argv[3], argv[4]);
  if (argc == 5 && std::string(argv[1]) == "source-cache-reference-lock") return holdSourceCacheReferenceLock(argv[2], argv[3], argv[4]);
  if (argc == 4 && std::string(argv[1]) == "source-cache-gc-remove") return removeSnapshotGcTree(argv[2], argv[3]);
  if (argc == 4 && std::string(argv[1]) == "create-profile") return createProfile(argv[2], argv[3]);
  if (argc == 4 && std::string(argv[1]) == "cleanup-profile") return cleanupProfile(argv[2], argv[3]);
  if (argc == 4 && std::string(argv[1]) == "initialize-run-profile") {
    std::string configYaml;
    if (!readPosixRunProfileConfig(configYaml)) return kInvalidInput;
    return initializePosixRunProfile(argv[2], argv[3], configYaml);
  }
  if (argc == 5 && std::string(argv[1]) == "project-selection") return projectSelection(argv[2], argv[3], argv[4]);
  if (argc == 9 && std::string(argv[1]) == "project-endpoint")
    return projectEndpoint(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8]);
  if (argc == 4 && std::string(argv[1]) == "verify-safe-path") return verifySafePosixPath(argv[3], argv[2]);
  return kInvalidInput;
}
#endif
