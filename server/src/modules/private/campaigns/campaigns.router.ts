// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import Campaign from "../../../shared/models/campaign.model.js";
import Lead, { LEAD_STATUSES } from "../../../shared/models/lead.model.js";
import Message from "../../../shared/models/message.model.js";
import Conversation from "../../../shared/models/conversation.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { audienceFilter } from "../../../shared/campaigns/campaign.service.js";
import { cancelPendingOutbound } from "../../../shared/conversations/followups.service.js";
import { getCurrentPolicy } from "../../../shared/policy/policy.service.js";
import { addBusinessDays } from "../../../shared/conversations/schedule.js";
import { oid } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";

const router = express.Router();

const tags = z.array(z.string().trim().min(1).max(80)).max(30);
const CampaignSchema = z.object({
    name: z.string().trim().min(2).max(120),
    objective: z.string().trim().max(500).default(""),
    audience: z.object({
        statuses: z.array(z.enum(LEAD_STATUSES)).min(1).default(["qualified"]),
        minScore: z.number().int().min(0).max(100).default(70),
        industries: tags.default([]),
        countries: tags.default([]),
    }),
    followUpDelaysDays: z.array(z.number().int().min(1).max(30)).max(5).default([3, 4]),
    dailyLimit: z.number().int().min(1).max(1000).default(20),
    autoSend: z.boolean().default(false),
}).strict();

const find = async (organizationId: mongoose.Types.ObjectId, id: string) => {
    const c = await Campaign.findOne({ organizationId, _id: oid(id) });
    if (!c) throw new NotFound("Campaign not found");
    return c;
};

// outcome analytics with explicit denominators (never "success" just because mail went out)
async function stats(organizationId: mongoose.Types.ObjectId, campaignId: mongoose.Types.ObjectId, since?: Date) {
    const range = since ? { createdAt: { $gte: since } } : {};
    const [byStatus, enrolled, convs, inbound] = await Promise.all([
        Message.aggregate([{ $match: { organizationId, campaignId, direction: "outbound", ...range } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
        Lead.countDocuments({ organizationId, campaignId }),
        Conversation.aggregate([{ $match: { organizationId, campaignId } }, { $group: { _id: { status: "$status", state: "$conversationState" }, n: { $sum: 1 } } }]),
        Message.aggregate([
            { $match: { organizationId, direction: "inbound", ...range } },
            { $lookup: { from: "conversations", localField: "conversationId", foreignField: "_id", as: "c" } },
            { $match: { "c.campaignId": campaignId } },
            { $group: { _id: "$intent", n: { $sum: 1 }, threads: { $addToSet: "$conversationId" } } },
        ]),
    ]);
    const s = Object.fromEntries(byStatus.map((r) => [r._id, r.n])) as Record<string, number>;
    const accepted = (s.sent ?? 0) + (s.delivered ?? 0) + (s.bounced ?? 0);
    const repliedThreads = new Set(inbound.filter((r) => r._id !== "out_of_office").flatMap((r) => r.threads.map(String))).size;
    const intent = (k: string) => inbound.find((r) => r._id === k)?.n ?? 0;
    const conv = (pred: (k: { status: string; state: string }) => boolean) => convs.filter((r) => pred(r._id)).reduce((a, r) => a + r.n, 0);
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
    return {
        range: since ? { from: since, to: new Date() } : "all time",
        enrolled,
        threads: conv(() => true),
        drafted: s.draft ?? 0,
        pendingApproval: s.pending_approval ?? 0,
        queued: (s.queued ?? 0) + (s.sending ?? 0),
        accepted,
        delivered: s.delivered ?? 0,
        bounced: s.bounced ?? 0,
        failed: (s.failed ?? 0) + (s.uncertain ?? 0),
        blockedByPolicy: s.rejected ?? 0,
        repliedThreads,
        optedOut: conv((k) => k.status === "suppressed"),
        complaints: intent("complaint"),
        meetings: conv((k) => k.state === "meeting_pending"),
        rates: {
            deliveryRate: { value: pct(s.delivered ?? 0, accepted), of: "accepted" },
            bounceRate: { value: pct(s.bounced ?? 0, accepted), of: "accepted" },
            replyRate: { value: pct(repliedThreads, conv(() => true)), of: "threads contacted" },
        },
    };
}

/*
    @route GET /api/v1/campaigns
*/
router.get("/", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const campaigns = await Campaign.find({ organizationId: ctx.organizationId }).sort({ createdAt: -1 }).lean();
    const counts = await Lead.aggregate([
        { $match: { organizationId: ctx.organizationId, campaignId: { $in: campaigns.map((c) => c._id) } } },
        { $group: { _id: "$campaignId", n: { $sum: 1 } } },
    ]);
    return Ok(res, "Campaigns", { campaigns: campaigns.map((c) => ({ ...c, enrolled: counts.find((x) => x._id.equals(c._id))?.n ?? 0 })) });
});

/*
    @route POST /api/v1/campaigns
*/
router.post("/", authorize("workflows.run"), validate(CampaignSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const campaign = await Campaign.create({ organizationId: ctx.organizationId, ...req.body, createdBy: ctx.userId });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "campaign.create", targetType: "campaign", targetId: String(campaign._id), outcome: "success" });
    return Created(res, "Campaign created", { campaign });
});

/*
    @route GET /api/v1/campaigns/:id
    @desc Campaign with analytics (optionally `?days=7`) and an audience preview
*/
router.get("/:id", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const campaign = await find(ctx.organizationId, String(req.params.id));
    const days = Number(req.query.days);
    const since = Number.isInteger(days) && days > 0 && days <= 365 ? new Date(Date.now() - days * 86400_000) : undefined;
    const [analytics, eligible, sample] = await Promise.all([
        stats(ctx.organizationId, campaign._id, since),
        Lead.countDocuments(audienceFilter(campaign)),
        Lead.find(audienceFilter(campaign), { company: 1, contact: 1, "qualification.score": 1 }).sort({ "qualification.score": -1 }).limit(5).lean(),
    ]);
    return Ok(res, "Campaign", { campaign, analytics, audience: { eligible, sample } });
});

/*
    @route PATCH /api/v1/campaigns/:id
*/
router.patch("/:id", authorize("workflows.run"), validate(CampaignSchema.partial()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const campaign = await find(ctx.organizationId, String(req.params.id));
    if (campaign.status === "completed") throw new Conflict("Completed campaigns cannot be edited");
    campaign.set(req.body);
    await campaign.save();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "campaign.update", targetType: "campaign", targetId: String(campaign._id), outcome: "success", metadata: req.body });
    return Ok(res, "Campaign updated", { campaign });
});

/*
    @route POST /api/v1/campaigns/:id/start
    @desc Activate: the worker enrolls eligible leads within the daily limit
*/
router.post("/:id/start", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const campaign = await find(ctx.organizationId, String(req.params.id));
    if (campaign.status === "active") return Ok(res, "Already active", { campaign });
    if (campaign.status === "completed") throw new Conflict("Completed campaigns cannot be restarted");
    const { config, version } = await getCurrentPolicy(ctx.organizationId);
    if (!config.outreach.enabled) throw new Conflict("Outreach is disabled in your policy");
    campaign.status = "active";
    campaign.policyVersion = version;
    campaign.startedAt = campaign.startedAt ?? new Date();
    await campaign.save();
    // resuming re-arms follow-ups for silent threads; every stop condition is re-checked when they come due
    await Conversation.updateMany({ organizationId: ctx.organizationId, campaignId: campaign._id, status: "waiting", nextActionAt: { $exists: false } }, { nextActionAt: addBusinessDays(new Date(), 1) });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "campaign.start", targetType: "campaign", targetId: String(campaign._id), outcome: "success", policyVersion: version });
    return Ok(res, "Campaign started", { campaign });
});

/*
    @route POST /api/v1/campaigns/:id/pause
    @desc Pause and cancel everything not yet sent (pause wins over scheduled jobs)
*/
router.post("/:id/pause", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const campaign = await find(ctx.organizationId, String(req.params.id));
    campaign.status = "paused";
    await campaign.save();
    await cancelPendingOutbound(ctx.organizationId, { campaignId: campaign._id }, "Campaign paused");
    await Conversation.updateMany({ organizationId: ctx.organizationId, campaignId: campaign._id }, { $unset: { nextActionAt: 1 } });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "campaign.pause", targetType: "campaign", targetId: String(campaign._id), outcome: "success" });
    return Ok(res, "Campaign paused", { campaign });
});

/*
    @route POST /api/v1/campaigns/:id/complete
*/
router.post("/:id/complete", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const campaign = await find(ctx.organizationId, String(req.params.id));
    campaign.status = "completed";
    await campaign.save();
    await cancelPendingOutbound(ctx.organizationId, { campaignId: campaign._id }, "Campaign completed");
    await Conversation.updateMany({ organizationId: ctx.organizationId, campaignId: campaign._id }, { $unset: { nextActionAt: 1 } });
    return Ok(res, "Campaign completed", { campaign });
});

export default router;
