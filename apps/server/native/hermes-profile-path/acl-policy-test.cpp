#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include "hermes-profile-path-acl-policy.h"

#include <cstdio>

namespace {

bool expect(const char* label, bool actual, bool expected) {
  if (actual == expected) return true;
  std::fprintf(stderr, "ACL policy assertion failed: %s\n", label);
  return false;
}

} // namespace

int main() {
  using ebb::hermes::profile_path::safeAncestorAcePolicy;
  using ebb::hermes::profile_path::safeWindowsPowerShellTrustedInstallerAcePolicy;
  constexpr BYTE effective = 0;
  constexpr BYTE inheritOnly = INHERIT_ONLY_ACE;
  constexpr BYTE inheritedEffective = INHERITED_ACE;
  constexpr BYTE foreignAllow = ACCESS_ALLOWED_ACE_TYPE;

  if (!expect("foreign FILE_LIST_DIRECTORY allowed",
      safeAncestorAcePolicy(foreignAllow, effective, FILE_LIST_DIRECTORY, false), true) ||
      !expect("foreign FILE_READ_EA allowed",
      safeAncestorAcePolicy(foreignAllow, effective, FILE_READ_EA, false), true) ||
      !expect("foreign add-file denied",
      safeAncestorAcePolicy(foreignAllow, effective, FILE_ADD_FILE, false), false) ||
      !expect("foreign add-subdirectory denied",
      safeAncestorAcePolicy(foreignAllow, effective, FILE_ADD_SUBDIRECTORY, false), false) ||
      !expect("foreign bounded traversal rights allowed",
      safeAncestorAcePolicy(foreignAllow, effective, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE, false), true) ||
      !expect("foreign delete denied",
      safeAncestorAcePolicy(foreignAllow, effective, DELETE, false), false) ||
      !expect("foreign write-DACL denied",
      safeAncestorAcePolicy(foreignAllow, effective, WRITE_DAC, false), false) ||
      !expect("foreign generic read denied",
      safeAncestorAcePolicy(foreignAllow, effective, GENERIC_READ, false), false) ||
      !expect("foreign generic write denied",
      safeAncestorAcePolicy(foreignAllow, effective, GENERIC_WRITE, false), false) ||
      !expect("foreign generic execute denied",
      safeAncestorAcePolicy(foreignAllow, effective, GENERIC_EXECUTE, false), false) ||
      !expect("foreign generic all denied",
      safeAncestorAcePolicy(foreignAllow, effective, GENERIC_ALL, false), false) ||
      !expect("trusted allow ACE remains trusted",
      safeAncestorAcePolicy(foreignAllow, effective, GENERIC_ALL, true), true) ||
      !expect("inherit-only generic ACE is ignored for current ancestor",
      safeAncestorAcePolicy(foreignAllow, inheritOnly, GENERIC_READ | GENERIC_EXECUTE, false), true) ||
      !expect("effective compound ACE denied",
      safeAncestorAcePolicy(0x04, effective, FILE_LIST_DIRECTORY, false), false) ||
      !expect("effective callback ACE denied",
      safeAncestorAcePolicy(0x09, effective, FILE_LIST_DIRECTORY, false), false) ||
      !expect("effective unknown ACE denied",
      safeAncestorAcePolicy(0x7f, effective, 0, false), false) ||
      !expect("inherit-only unknown ACE does not apply here",
      safeAncestorAcePolicy(0x7f, inheritOnly, 0, false), true) ||
      !expect("foreign ACCESS_DENIED delete ACE remains non-granting",
      safeAncestorAcePolicy(ACCESS_DENIED_ACE_TYPE, effective, DELETE | GENERIC_WRITE, false), true) ||
      !expect("foreign SYSTEM_AUDIT ACE remains non-granting",
      safeAncestorAcePolicy(SYSTEM_AUDIT_ACE_TYPE, effective, GENERIC_ALL, false), true) ||
      !expect("TrustedInstaller full control allowed only in exact system PowerShell chain",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, true, ACCESS_ALLOWED_ACE_TYPE, inheritedEffective, FILE_ALL_ACCESS), true) ||
      !expect("TrustedInstaller generic all allowed only in exact system PowerShell chain",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, true, ACCESS_ALLOWED_ACE_TYPE, inheritedEffective, GENERIC_ALL), true) ||
      !expect("TrustedInstaller exception denied outside exact system chain",
      safeWindowsPowerShellTrustedInstallerAcePolicy(false, true, ACCESS_ALLOWED_ACE_TYPE, inheritedEffective, FILE_ALL_ACCESS), false) ||
      !expect("other principals do not receive TrustedInstaller exception",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, false, ACCESS_ALLOWED_ACE_TYPE, inheritedEffective, FILE_ALL_ACCESS), false) ||
      !expect("partial TrustedInstaller mask remains denied",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, true, ACCESS_ALLOWED_ACE_TYPE, inheritedEffective, FILE_ALL_ACCESS & ~FILE_ADD_FILE), false) ||
      !expect("expanded TrustedInstaller mask remains denied",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, true, ACCESS_ALLOWED_ACE_TYPE, inheritedEffective, FILE_ALL_ACCESS | GENERIC_READ), false) ||
      !expect("non-allow ACE does not receive TrustedInstaller exception",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, true, ACCESS_DENIED_ACE_TYPE, inheritedEffective, FILE_ALL_ACCESS), false) ||
      !expect("inherit-only TrustedInstaller ACE is not an effective grant",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, true, ACCESS_ALLOWED_ACE_TYPE, inheritOnly, GENERIC_ALL), false) ||
      !expect("explicit TrustedInstaller ACE does not receive inherited-system exception",
      safeWindowsPowerShellTrustedInstallerAcePolicy(true, true, ACCESS_ALLOWED_ACE_TYPE, effective, FILE_ALL_ACCESS), false)) {
    return 1;
  }

  std::puts("Native ancestor ACL policy unit cases passed.");
  return 0;
}
