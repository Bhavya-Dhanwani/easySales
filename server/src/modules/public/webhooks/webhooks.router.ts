// Importing modules
import express, { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import mongoose from "mongoose";
import EmailIntegration from "../../../shared/models/emailIntegration.model.js";
import ProviderEvent from "../../../shared/models/providerEvent.model.js";
import { decryptSecret } from "../../../shared/utils/crypto.util.js";
import Unauthorized from "../../../shared/errors/Unauthorized.error.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";

const router = express.Router();

// normalized event contract any mail provider / forwarder can be mapped onto
const EventSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("inbound"),
        id: z.string().min(1).max(200),
        messageId: z.string().max(500).optional(),
        from: z.string().email(),
        subject: z.string().max(500).default(""),
        text: z.string().max(50_000),
        inReplyTo: z.string().max(500).optional(),
        references: z.array(z.string().max(500)).max(50).optional(),
        autoSubmitted: z.boolean().optional(),
        occurredAt: z.coerce.date().optional(),
    }),
    z.object({
        type: z.enum(["delivered", "bounced", "complained"]),
        id: z.string().min(1).max(200),
        providerMessageId: z.string().max(500),
        bounceType: z.enum(["hard", "soft"]).optional(),
        occurredAt: z.coerce.date().optional(),
    }),
]);
const BodySchema = z.object({ events: z.array(EventSchema).min(1).max(100) });

// constant-time HMAC-SHA256 of the raw body with the integration's own secret
export function verifySignature(secret: string, rawBody: Buffer | undefined, signature: string | undefined) {
    if (!rawBody || !signature) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const given = signature.replace(/^sha256=/, "");
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/*
    @route POST /api/webhooks/email/:integrationId
    @desc Provider events (inbound replies, delivered, bounced, complained). The tenant is
          resolved from the connected integration and its signature, never from the payload.
          Events are persisted (deduplicated) before the 202, then processed by the worker.
    @access Signed with the integration's webhook secret
*/
router.post("/email/:integrationId", async (req: Request & { rawBody?: Buffer }, res: Response) => {
    const id = req.params.integrationId;
    const integration = mongoose.isValidObjectId(id)
        ? await EmailIntegration.findOne({ _id: id }).setOptions({ crossTenant: true }).lean()
        : null;
    // same answer for unknown integration and bad signature
    if (!integration || !verifySignature(decryptSecret(integration.webhookSecretEnc), req.rawBody, req.header("x-easysales-signature"))) {
        throw new Unauthorized("Invalid signature");
    }
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequest("Invalid payload");

    const docs = parsed.data.events.map((e) => ({
        organizationId: integration.organizationId, integrationId: integration._id, eventId: e.id, type: e.type,
        occurredAt: e.occurredAt ?? new Date(), payload: e,
    }));
    let accepted = docs.length;
    try {
        await ProviderEvent.insertMany(docs, { ordered: false });
    } catch (error) {
        const e = error as { code?: number; insertedDocs?: unknown[]; writeErrors?: unknown[] };
        if (!e.writeErrors && e.code !== 11000) throw error;
        accepted = e.insertedDocs?.length ?? docs.length - (e.writeErrors?.length ?? 0);
    }
    return ApiResponse(res, 202, "Accepted", { accepted, duplicates: docs.length - accepted });
});

export default router;
