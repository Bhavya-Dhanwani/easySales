export const ROLES = ["owner", "admin", "sales_manager", "sales_rep", "developer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
    "org.manage", "members.manage",
    "profile.read", "profile.write",
    "policies.read", "policies.write",
    "leads.read", "leads.write",
    "workflows.run",
    "approvals.read", "approvals.decide",
    "conversations.read", "conversations.write",
    "proposals.read", "proposals.write",
    "audit.read", "usage.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = PERMISSIONS.filter((p) => p.endsWith(".read"));

// server-side source of truth for what each role may do
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
    owner: PERMISSIONS,
    admin: PERMISSIONS,
    sales_manager: [
        ...READ_ONLY, "leads.write", "workflows.run", "approvals.decide",
        "conversations.write", "proposals.write",
    ],
    sales_rep: [
        "profile.read", "policies.read", "leads.read", "leads.write", "workflows.run",
        "approvals.read", "conversations.read", "conversations.write", "proposals.read", "proposals.write",
    ],
    developer: ["profile.read", "leads.read", "conversations.read", "proposals.read", "usage.read"],
    viewer: READ_ONLY,
};

export function can(role: Role, permission: Permission) {
    return ROLE_PERMISSIONS[role].includes(permission);
}
