// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import Organization from "../../../shared/models/organization.model.js";
import Membership from "../../../shared/models/membership.model.js";
import User from "../../../shared/models/user.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import { ROLES } from "../../../shared/tenancy/rbac.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { exportTenant, purgeTenant } from "../../../shared/tenancy/tenantData.service.js";
import sendMail from "../../../shared/utils/sendMail.util.js";
import env from "../../../shared/config/env.config.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";
import Forbidden from "../../../shared/errors/Forbidden.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import { oid } from "../../../shared/utils/request.util.js";

const router = express.Router();

const UpdateOrgSchema = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }, "Unknown timezone").optional(),
    defaultCurrency: z.string().length(3).toUpperCase().optional(),
}).strict();

const InviteSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    role: z.enum(ROLES),
}).strict();

const RoleSchema = z.object({ role: z.enum(ROLES) }).strict();

/*
    @route GET /api/v1/organization
    @desc Current organization and the caller's role
*/
router.get("/", async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const org = await Organization.findById(ctx.organizationId).lean();
    return Ok(res, "Organization", { organization: org, role: ctx.role });
});

/*
    @route PATCH /api/v1/organization
    @desc Update organization settings
*/
router.patch("/", authorize("org.manage"), validate(UpdateOrgSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const org = await Organization.findByIdAndUpdate(ctx.organizationId, req.body, { new: true, runValidators: true }).lean();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "organization.update", outcome: "success", metadata: req.body });
    return Ok(res, "Organization updated", { organization: org });
});

/*
    @route GET /api/v1/organization/members
*/
router.get("/members", authorize("members.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const members = await Membership.find({ organizationId: ctx.organizationId }).sort({ createdAt: 1 }).lean();
    const users = await User.find({ _id: { $in: members.map((m) => m.userId).filter(Boolean) } }, { name: 1, email: 1 }).lean();
    return Ok(res, "Members", {
        members: members.map((m) => ({ ...m, name: users.find((u) => m.userId && u._id.equals(m.userId))?.name ?? null })),
    });
});

/*
    @route POST /api/v1/organization/members
    @desc Invite a member by email (activates on verified sign-in)
*/
router.post("/members", authorize("members.manage"), validate(InviteSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    if (req.body.role === "owner" && ctx.role !== "owner") throw new Forbidden("Only owners can invite owners");

    const existingUser = await User.findOne({ email: req.body.email, isVerified: true }).lean();
    const membership = await Membership.create({
        organizationId: ctx.organizationId, email: req.body.email, role: req.body.role,
        userId: existingUser?._id ?? null, status: existingUser ? "active" : "invited",
        invitedBy: new mongoose.Types.ObjectId(ctx.userId),
    });
    const org = await Organization.findById(ctx.organizationId).lean();
    sendMail(req.body.email, `You're invited to ${org?.name} on easySales`, `You have been invited as ${req.body.role}. Sign in or create an account with this email at <a href="${env.FRONTEND_URL}/login">${env.FRONTEND_URL}</a>.`);
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "member.invite", targetType: "membership", targetId: membership._id.toString(), outcome: "success", metadata: { email: req.body.email, role: req.body.role } });
    return Created(res, "Invitation sent", { membership });
});

// guard: an organization must always keep at least one active owner
async function assertNotLastOwner(organizationId: mongoose.Types.ObjectId, membershipId: mongoose.Types.ObjectId) {
    const owners = await Membership.countDocuments({ organizationId, role: "owner", status: "active", _id: { $ne: membershipId } });
    if (owners === 0) throw new Conflict("An organization needs at least one owner");
}

/*
    @route PATCH /api/v1/organization/members/:id
*/
router.patch("/members/:id", authorize("members.manage"), validate(RoleSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const membership = await Membership.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) });
    if (!membership) throw new NotFound("Member not found");
    if ((membership.role === "owner" || req.body.role === "owner") && ctx.role !== "owner") throw new Forbidden("Only owners can change owner roles");
    if (membership.role === "owner" && req.body.role !== "owner") await assertNotLastOwner(ctx.organizationId, membership._id);
    membership.role = req.body.role;
    await membership.save();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "member.role_change", targetType: "membership", targetId: membership._id.toString(), outcome: "success", metadata: { role: req.body.role } });
    return Ok(res, "Member updated", { membership });
});

/*
    @route DELETE /api/v1/organization/members/:id
*/
router.delete("/members/:id", authorize("members.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const membership = await Membership.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) });
    if (!membership) throw new NotFound("Member not found");
    if (membership.role === "owner") {
        if (ctx.role !== "owner") throw new Forbidden("Only owners can remove owners");
        await assertNotLastOwner(ctx.organizationId, membership._id);
    }
    await Membership.deleteOne({ organizationId: ctx.organizationId, _id: membership._id });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "member.remove", targetType: "membership", targetId: membership._id.toString(), outcome: "success", metadata: { email: membership.email } });
    return Ok(res, "Member removed");
});

/*
    @route GET /api/v1/organization/export
    @desc Export all tenant data (data portability)
*/
router.get("/export", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "organization.export", outcome: "success" });
    res.setHeader("Content-Disposition", `attachment; filename="easysales-export-${ctx.organizationId}.json"`);
    return res.json(await exportTenant(ctx.organizationId));
});

/*
    @route DELETE /api/v1/organization
    @desc Permanently delete the organization and all of its data (owner only)
*/
router.delete("/", validate(z.object({ confirm: z.string() })), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    if (ctx.role !== "owner") throw new Forbidden("Only owners can delete the organization");
    const org = await Organization.findById(ctx.organizationId).lean();
    if (req.body.confirm !== org?.name) throw new Conflict("Type the organization name to confirm deletion");
    await purgeTenant(ctx.organizationId);
    return Ok(res, "Organization deleted");
});

export default router;
