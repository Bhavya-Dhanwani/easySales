// Importing modules
import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Membership from "../models/membership.model.js";
import Organization from "../models/organization.model.js";
import Forbidden from "../errors/Forbidden.error.js";
import Unauthorized from "../errors/Unauthorized.error.js";
import { can, Permission, Role } from "./rbac.js";

// the resolved, server-verified tenant context for an authenticated request
export interface TenantContext {
    userId: string;
    organizationId: mongoose.Types.ObjectId;
    role: Role;
}

export type TenantRequest = Request & { user?: { userId?: string }; ctx?: TenantContext };

/*
    Resolves the active organization from the X-Organization-Id header (or the user's
    first active membership) and verifies the membership in the database. The client
    never gets to assert its own organization or role.
*/
async function orgContext(req: TenantRequest, res: Response, next: NextFunction) {

    const userId = req.user?.userId;
    if (!userId || !mongoose.isValidObjectId(userId)) throw new Unauthorized("User unauthenticated.");

    const requested = req.header("x-organization-id");
    if (requested && !mongoose.isValidObjectId(requested)) throw new Forbidden("Invalid organization");

    // memberships are looked up per user across tenants, so this query is explicitly cross-tenant
    const filter: Record<string, unknown> = { userId, status: "active" };
    if (requested) filter.organizationId = requested;
    const membership = await Membership.findOne(filter).sort({ createdAt: 1 }).setOptions({ crossTenant: true }).lean();
    if (!membership) throw new Forbidden("You are not a member of this organization");

    const org = await Organization.findById(membership.organizationId).lean();
    if (!org || org.status !== "active") throw new Forbidden("Organization is not active");

    req.ctx = { userId, organizationId: membership.organizationId, role: membership.role as Role };
    next();

}

// route guard: the active role must hold the permission
export function authorize(permission: Permission) {
    return (req: TenantRequest, res: Response, next: NextFunction) => {
        if (!req.ctx || !can(req.ctx.role, permission)) throw new Forbidden(`Missing permission: ${permission}`);
        next();
    };
}

// narrows a request to one that has passed orgContext
export function ctxOf(req: Request): TenantContext {
    const ctx = (req as TenantRequest).ctx;
    if (!ctx) throw new Unauthorized("Missing tenant context");
    return ctx;
}

export default orgContext;
