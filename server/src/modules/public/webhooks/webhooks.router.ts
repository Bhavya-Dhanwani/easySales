// Importing modules
import express, { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import mongoose from "mongoose";
import Conversation from "../../../shared/models/conversation.model.js";
import Lead from "../../../shared/models/lead.model.js";
import { recordInbound } from "../../../shared/conversations/inbound.service.js";
import { normalizeEmail } from "../../../shared/policy/policy.service.js";
import env from "../../../shared/config/env.config.js";
import Unauthorized from "../../../shared/errors/Unauthorized.error.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";

const router = express.Router();

const InboundEmailSchema = z.object({
    eventId: z.string().min(1).max(200),
    organizationId: z.string().refine(mongoose.isValidObjectId),
    conversationId: z.string().refine(mongoose.isValidObjectId),
    from: z.string().email(),
    subject: z.string().max(300).optional(),
    text: z.string().min(1).max(20000),
});

// constant-time HMAC-SHA256 verification of the raw request body
export function verifySignature(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!env.WEBHOOK_SECRET || !rawBody || !signature) return false;
    const expected = createHmac("sha256", env.WEBHOOK_SECRET).update(rawBody).digest("hex");
    const given = signature.replace(/^sha256=/, "");
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/*
    @route POST /api/webhooks/email/inbound
    @desc Inbound email from a mail provider / forwarding service (HMAC signed)
    @access Signed
*/
router.post("/email/inbound", async (req: Request & { rawBody?: Buffer }, res: Response) => {
    if (!verifySignature(req.rawBody, req.header("x-easysales-signature"))) throw new Unauthorized("Invalid signature");
    const parsed = InboundEmailSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequest("Invalid payload");
    const event = parsed.data;

    const organizationId = new mongoose.Types.ObjectId(event.organizationId);
    const conversation = await Conversation.findOne({ organizationId, _id: event.conversationId }).lean();
    if (!conversation) throw new NotFound("Conversation not found");
    // the sender must be the lead on this thread; otherwise it is not a reply we trust
    const lead = await Lead.findOne({ organizationId, _id: conversation.leadId }).lean();
    if (!lead?.contact?.email || normalizeEmail(lead.contact.email) !== normalizeEmail(event.from)) {
        throw new BadRequest("Sender does not match the conversation");
    }

    const result = await recordInbound(organizationId, conversation._id, {
        from: event.from, subject: event.subject, body: event.text, eventKey: `webhook:${event.eventId}`,
    }, { type: "system", id: "webhook:email" });
    return ApiResponse(res, 202, result.duplicate ? "Duplicate event ignored" : "Accepted", { workflowId: result.workflowId });
});

export default router;
