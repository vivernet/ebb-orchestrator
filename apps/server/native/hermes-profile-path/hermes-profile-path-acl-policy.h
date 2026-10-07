#pragma once

#include <windows.h>

namespace ebb::hermes::profile_path {

constexpr ACCESS_MASK kAllowedForeignDirectoryRights = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY |
  FILE_TRAVERSE | FILE_LIST_DIRECTORY | FILE_READ_EA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;

/**
 * Determines whether one ACE is compatible with the bounded policy for a lexical ancestor above auth-root.
 * INHERIT_ONLY ACEs do not apply to the current ancestor and are evaluated on descendants when those handles
 * are checked. Effective foreign allow ACEs may contain only the explicit directory rights above; deny and
 * audit ACEs grant no access, while unrecognized effective ACE types fail closed.
 */
inline constexpr bool safeAncestorAcePolicy(BYTE aceType, BYTE aceFlags, ACCESS_MASK mask, bool trusted) noexcept {
  if ((aceFlags & INHERIT_ONLY_ACE) != 0) return true;
  if (aceType == ACCESS_ALLOWED_ACE_TYPE) {
    return trusted || (mask & ~kAllowedForeignDirectoryRights) == 0;
  }
  if (aceType == ACCESS_DENIED_ACE_TYPE || aceType == SYSTEM_AUDIT_ACE_TYPE) return true;
  return false;
}

} // namespace ebb::hermes::profile_path
