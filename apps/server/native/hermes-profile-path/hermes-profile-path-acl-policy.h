#pragma once

#include <windows.h>

namespace ebb::hermes::profile_path {

constexpr ACCESS_MASK kAllowedForeignDirectoryRights =
  FILE_TRAVERSE | FILE_LIST_DIRECTORY | FILE_READ_EA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
constexpr ACCESS_MASK kAllowedForeignVolumeRootDirectoryRights =
  kAllowedForeignDirectoryRights | FILE_ADD_SUBDIRECTORY;

/**
 * Determines whether one ACE is compatible with the bounded policy for a lexical ancestor above auth-root.
 * INHERIT_ONLY ACEs do not apply to the current ancestor and are evaluated on descendants when those handles
 * are checked. Effective foreign allow ACEs may contain only the explicit read/traversal rights above; deny and
 * audit ACEs grant no access, while unrecognized effective ACE types fail closed.
 */
inline constexpr bool safeAncestorAcePolicy(BYTE aceType, BYTE aceFlags, ACCESS_MASK mask, bool trusted,
                                            bool verifiedVolumeRootIndex = false) noexcept {
  if ((aceFlags & INHERIT_ONLY_ACE) != 0) return true;
  if (aceType == ACCESS_ALLOWED_ACE_TYPE) {
    const ACCESS_MASK allowedRights = verifiedVolumeRootIndex
      ? kAllowedForeignVolumeRootDirectoryRights
      : kAllowedForeignDirectoryRights;
    return trusted || (mask & ~allowedRights) == 0;
  }
  if (aceType == ACCESS_DENIED_ACE_TYPE || aceType == SYSTEM_AUDIT_ACE_TYPE) return true;
  return false;
}

/**
 * Restricts the TrustedInstaller exception to the OS-derived Windows PowerShell dependency chain and
 * the two canonical full-control masks emitted by Windows system-directory ACLs.
 */
inline constexpr bool safeWindowsPowerShellTrustedInstallerAcePolicy(
    bool exactSystemDependencyChain, bool trustedInstaller, BYTE aceType, BYTE aceFlags, ACCESS_MASK mask) noexcept {
  return exactSystemDependencyChain && trustedInstaller && aceType == ACCESS_ALLOWED_ACE_TYPE &&
    (aceFlags & INHERIT_ONLY_ACE) == 0 && (aceFlags & INHERITED_ACE) != 0 &&
    (mask == FILE_ALL_ACCESS || mask == GENERIC_ALL);
}

} // namespace ebb::hermes::profile_path
