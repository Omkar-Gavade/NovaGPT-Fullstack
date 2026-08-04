/**
 * Roles, and what each may do.
 *
 * Deliberately flat: three roles and a permission table. Fine-grained RBAC
 * before there is a second kind of user is complexity with no requirement
 * behind it, and the table below makes adding a role cheap when one appears
 * (docs/backend/10-security.md#roles).
 */

export const Role = {
  ANONYMOUS: "anonymous",
  USER: "user",
  ADMIN: "admin",
};

/**
 * Permissions, named after what they let a caller do rather than after an
 * endpoint. An endpoint-named permission has to be renamed every time a route
 * moves, and renaming a permission is how one silently stops being checked.
 */
export const Permission = {
  READ_CATALOG: "catalog:read",
  READ_SHARED: "shared:read",
  CHAT: "chat:write",
  MANAGE_OWN_THREADS: "threads:own",
  READ_OWN_USAGE: "usage:own",
  ADMIN_METRICS: "admin:metrics",
  ADMIN_PROVIDERS: "admin:providers",
  ADMIN_AUDIT: "admin:audit",
};

const GRANTS = {
  [Role.ANONYMOUS]: [Permission.READ_CATALOG, Permission.READ_SHARED],
  [Role.USER]: [
    Permission.READ_CATALOG,
    Permission.READ_SHARED,
    Permission.CHAT,
    Permission.MANAGE_OWN_THREADS,
    Permission.READ_OWN_USAGE,
  ],
  [Role.ADMIN]: Object.values(Permission),
};

/** Unknown roles grant nothing. A typo in a stored role must not escalate. */
export function permissionsFor(role) {
  return GRANTS[role] ?? [];
}

export function roleGrants(role, permission) {
  return permissionsFor(role).includes(permission);
}

export function isRole(value) {
  return Object.values(Role).includes(value);
}
