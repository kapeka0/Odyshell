import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

const statements = {
  ...defaultStatements,
  machine: ["create", "read", "update", "delete"],
  agent: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  session: ["read", "approve", "revoke"],
  audit: ["read"],
} as const;

export const identityAccessControl = createAccessControl(statements);

export const ownerRole = identityAccessControl.newRole({
  ...ownerAc.statements,
  machine: ["create", "read", "update", "delete"],
  agent: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  session: ["read", "approve", "revoke"],
  audit: ["read"],
});

export const adminRole = identityAccessControl.newRole({
  ...adminAc.statements,
  machine: ["create", "read", "update", "delete"],
  agent: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  session: ["read", "approve", "revoke"],
  audit: ["read"],
});

export const supervisorRole = identityAccessControl.newRole({
  ...memberAc.statements,
  machine: ["read"],
  agent: ["read"],
  policy: ["read"],
  session: ["read", "approve", "revoke"],
  audit: ["read"],
});

export const identityRoles = {
  owner: ownerRole,
  admin: adminRole,
  supervisor: supervisorRole,
};

export type IdentityRole = keyof typeof identityRoles;

export function identityRole(value: string): IdentityRole | null {
  if (value === "owner" || value === "admin" || value === "supervisor") {
    return value;
  }
  return null;
}

export function canAdministerOrganization(role: IdentityRole): boolean {
  return role === "owner" || role === "admin";
}
