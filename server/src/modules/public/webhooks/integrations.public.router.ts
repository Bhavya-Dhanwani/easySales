// Importing modules
import express, { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IntegrationConnection, IntegrationEvent, OAUTH_PROVIDERS, OAuthProvider } from "../../../shared/models/integration.model.js";
import { completeConnect } from "../../../shared/integrations/connection.service.js";
import env from "../../../shared/config/env.config.js";
import logger from "../../../shared/config/logger.config.js";
import Unauthorized from "../../../shared/errors/Unauthorized.error.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import ApiError from "../../../shared/utils/ApiError.util.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";

export const oauthRouter = express.Router();
export const hubspotWebhookRouter = express.Router();

const app = () => `${env.FRONTEND_URL.replace(/\/$/, "")}/app/integrations`;

/*
    @route GET /api/integrations/oauth/:provider/callback
    @desc Provider redirect after consent. No session here: the single-use state binds it to a tenant.
*/
oauthRouter.get("/:provider/callback", async (req: Request, res: Response) => {
    const provider = String(req.params.provider) as OAuthProvider;
    if (!OAUTH_PROVIDERS.includes(provider)) return res.redirect(`${app()}?error=unknown_provider`);
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (req.query.error || !code || !state) return res.redirect(`${app()}?error=${encodeURIComponent(String(req.query.error ?? "missing_code"))}`);
    try {
        await completeConnect(provider, code, state);
        return res.redirect(`${app()}?connected=${provider}`);
    } catch (error) {
        logger.warn({ provider, error: (error as Error).message }, "OAuth callback failed");
        return res.redirect(`${app()}?error=${encodeURIComponent((error as Error).message.slice(0, 120))}`);
    }
});

const HubSpotEvents = z.array(z.object({
    eventId: z.union([z.number(), z.string()]).transform(String),
    portalId: z.union([z.number(), z.string()]).transform(String),
    subscriptionType: z.string().regex(/^(contact|company|deal)\.(creation|deletion|propertyChange|merge|restore|associationChange)$/),
    objectId: z.union([z.number(), z.string()]).transform(String),
    occurredAt: z.number().optional(),
    propertyName: z.string().optional(),
    propertyValue: z.string().optional(),
}).passthrough()).min(1).max(200);

// HubSpot signature v3: base64 HMAC-SHA256(client secret, method + uri + body + timestamp); 5-minute replay window
export function verifyHubSpot(req: Request & { rawBody?: Buffer }) {
    const signature = req.header("x-hubspot-signature-v3");
    const timestamp = Number(req.header("x-hubspot-request-timestamp"));
    if (!signature || !timestamp || Math.abs(Date.now() - timestamp) > 5 * 60_000) return false;
    const uri = `${(env.PUBLIC_API_URL || env.FRONTEND_URL).replace(/\/$/, "")}/api/webhooks/hubspot`;
    const expected = createHmac("sha256", env.HUBSPOT_CLIENT_SECRET).update(`POST${uri}${req.rawBody?.toString("utf8") ?? ""}${timestamp}`).digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
}

/*
    @route POST /api/webhooks/hubspot
    @desc Verify, store each event once (deduplicated), acknowledge fast; the worker re-reads the
          objects from HubSpot. The tenant comes from our connection for that portal, never from the payload.
*/
hubspotWebhookRouter.post("/", async (req: Request, res: Response) => {
    if (!env.HUBSPOT_CLIENT_SECRET) throw new ApiError(503, "HubSpot is not configured");
    if (!verifyHubSpot(req)) throw new Unauthorized("Invalid signature");
    const parsed = HubSpotEvents.safeParse(req.body);
    if (!parsed.success) throw new BadRequest("Malformed HubSpot events");
    let stored = 0;
    for (const e of parsed.data) {
        const conn = await IntegrationConnection.findOne({ provider: "hubspot", externalAccountId: e.portalId, status: { $ne: "disconnected" } }).setOptions({ crossTenant: true }).lean();
        if (!conn) continue;
        try {
            await IntegrationEvent.create({
                organizationId: conn.organizationId, connectionId: conn._id, provider: "hubspot", eventId: e.eventId, type: e.subscriptionType,
                objectId: e.objectId, payload: { propertyName: e.propertyName, propertyValue: e.propertyValue }, occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
            });
            stored += 1;
        } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
        }
    }
    return ApiResponse(res, 200, "Accepted", { stored });
});
