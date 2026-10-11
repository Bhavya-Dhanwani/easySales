// Importing modules
import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { IntegrationConnection, OAuthProvider, OAuthState } from "../models/integration.model.js";
import { encryptSecret, decryptSecret } from "../utils/crypto.util.js";
import { audit } from "../audit/audit.service.js";
import { alert } from "../alerts/alert.service.js";
import env from "../config/env.config.js";
import { ADAPTERS } from "./providers.js";
import { ReconnectRequiredError } from "./core.js";
import BadRequest from "../errors/BadRequest.error.js";
import Conflict from "../errors/Conflict.error.js";
import NotFound from "../errors/NotFound.error.js";
import ApiError from "../utils/ApiError.util.js";

type Id = mongoose.Types.ObjectId | string;
type Conn = InstanceType<typeof IntegrationConnection>;

export const redirectUri = (provider: OAuthProvider) => `${(env.PUBLIC_API_URL || env.FRONTEND_URL).replace(/\/$/, "")}/api/integrations/oauth/${provider}/callback`;

function configured(provider: OAuthProvider) {
    const ok = provider === "hubspot" ? env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET : env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET;
    if (!ok) throw new ApiError(503, `${provider} is not configured on this server (missing OAuth client credentials)`);
}

/*
    Step 1: a single-use state (CSRF) bound to this tenant and user, plus a PKCE verifier
    where the provider supports it. The browser is sent to the provider's consent screen.
*/
export async function startConnect(organizationId: Id, userId: string, provider: OAuthProvider) {
    configured(provider);
    const adapter = ADAPTERS[provider];
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = adapter.pkce ? randomBytes(48).toString("base64url") : undefined;
    const challenge = codeVerifier ? createHash("sha256").update(codeVerifier).digest("base64url") : undefined;
    await OAuthState.create({ state, organizationId, userId, provider, codeVerifier, expiresAt: new Date(Date.now() + 10 * 60_000) });
    return { authorizeUrl: adapter.authorizeUrl(state, redirectUri(provider), challenge) };
}

/*
    Step 2 (public callback): the state is consumed atomically, so it works once and only for
    the provider it was issued for; the tenant comes from our record, never from the request.
*/
export async function completeConnect(provider: OAuthProvider, code: string, state: string) {
    const s = await OAuthState.findOneAndDelete({ state, provider, expiresAt: { $gt: new Date() } });
    if (!s) throw new BadRequest("This connection link expired or was already used. Start again from Integrations.");
    const adapter = ADAPTERS[provider];
    const tokens = await adapter.exchangeCode(code, redirectUri(provider), s.codeVerifier ?? undefined);
    const owner = await IntegrationConnection.findOne({ provider, externalAccountId: tokens.accountId, status: { $ne: "disconnected" }, organizationId: { $ne: s.organizationId } }).setOptions({ crossTenant: true }).lean();
    if (owner) throw new Conflict("This account is already connected to another workspace");
    const conn = await IntegrationConnection.findOneAndUpdate(
        { organizationId: s.organizationId, provider },
        {
            status: "connected", externalAccountId: tokens.accountId, accountLabel: tokens.accountLabel, scopes: tokens.scopes ?? adapter.scopes,
            accessTokenEnc: encryptSecret(tokens.accessToken), ...(tokens.refreshToken && { refreshTokenEnc: encryptSecret(tokens.refreshToken) }),
            accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000), lastHealthCheckAt: new Date(), lastError: null, connectedBy: s.userId,
        },
        { upsert: true, new: true },
    );
    await audit({ organizationId: s.organizationId, actorType: "user", actorId: s.userId, action: "integration.connect", targetType: "integration", targetId: String(conn._id), outcome: "success", metadata: { provider, account: tokens.accountLabel ?? tokens.accountId } });
    return conn;
}

async function markDegraded(conn: Conn, message: string) {
    if (conn.status === "connected") await alert(conn.organizationId, "provider_outage", `${conn.provider}: ${message}`);
    await IntegrationConnection.updateOne({ organizationId: conn.organizationId, _id: conn._id }, { status: "degraded", lastError: message.slice(0, 300) });
    await audit({ organizationId: conn.organizationId, actorType: "system", actorId: "integrations", action: "integration.degraded", targetType: "integration", targetId: String(conn._id), outcome: "failure", metadata: { provider: conn.provider, error: message } });
}

// the live connection with a valid access token (refreshed a minute before expiry)
export async function connectionWithToken(organizationId: Id, provider: OAuthProvider) {
    const conn = await IntegrationConnection.findOne({ organizationId, provider, status: { $ne: "disconnected" } }).select("+accessTokenEnc +refreshTokenEnc");
    if (!conn) throw new NotFound(`${provider} is not connected`);
    if (conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - 60_000 > Date.now()) {
        return { conn, token: decryptSecret(conn.accessTokenEnc!) };
    }
    if (!conn.refreshTokenEnc) {
        await markDegraded(conn, "access expired and no refresh token was granted; reconnect");
        throw new ReconnectRequiredError(provider);
    }
    try {
        const t = await ADAPTERS[provider].refresh(decryptSecret(conn.refreshTokenEnc));
        conn.accessTokenEnc = encryptSecret(t.accessToken);
        if (t.refreshToken) conn.refreshTokenEnc = encryptSecret(t.refreshToken);
        conn.accessTokenExpiresAt = new Date(Date.now() + t.expiresIn * 1000);
        await conn.save();
        return { conn, token: t.accessToken };
    } catch (error) {
        if (error instanceof ReconnectRequiredError) await markDegraded(conn, error.message);
        throw error;
    }
}

// runs a provider call with the connection's token; a revoked grant degrades the connection
export async function withProvider<T>(organizationId: Id, provider: OAuthProvider, fn: (token: string, conn: Conn) => Promise<T>) {
    const { conn, token } = await connectionWithToken(organizationId, provider);
    try {
        return await fn(token, conn);
    } catch (error) {
        if (error instanceof ReconnectRequiredError) await markDegraded(conn, error.message);
        throw error;
    }
}

export async function testConnection(organizationId: Id, provider: OAuthProvider) {
    try {
        await withProvider(organizationId, provider, (token) => ADAPTERS[provider].testConnection(token));
        await IntegrationConnection.updateOne({ organizationId, provider }, { status: "connected", lastHealthCheckAt: new Date(), lastError: null });
        return { healthy: true };
    } catch (error) {
        await IntegrationConnection.updateOne({ organizationId, provider }, { lastHealthCheckAt: new Date(), lastError: (error as Error).message.slice(0, 300) });
        return { healthy: false, error: (error as Error).message };
    }
}

// revokes at the provider (best effort) and deletes our copy of the tokens
export async function disconnect(organizationId: Id, provider: OAuthProvider, userId: string) {
    const conn = await IntegrationConnection.findOne({ organizationId, provider }).select("+accessTokenEnc +refreshTokenEnc");
    if (!conn) throw new NotFound(`${provider} is not connected`);
    const adapter = ADAPTERS[provider];
    const token = conn.refreshTokenEnc ?? conn.accessTokenEnc;
    if (adapter.revoke && token) await adapter.revoke(decryptSecret(token)).catch(() => undefined);
    await IntegrationConnection.updateOne({ organizationId, _id: conn._id }, { status: "disconnected", $unset: { accessTokenEnc: 1, refreshTokenEnc: 1, accessTokenExpiresAt: 1 } });
    await audit({ organizationId, actorType: "user", actorId: userId, action: "integration.disconnect", targetType: "integration", targetId: String(conn._id), outcome: "success", metadata: { provider } });
}

// what the dashboard may see: status, account, sync state; never tokens
export const connectionView = (c: { _id: unknown; provider: string; status: string; accountLabel?: string | null; externalAccountId: string; scopes?: string[]; lastSyncAt?: Date | null; lastHealthCheckAt?: Date | null; lastError?: string | null; settings?: unknown; cursors?: unknown }) => ({
    _id: c._id, provider: c.provider, status: c.status, account: c.accountLabel ?? c.externalAccountId, scopes: c.scopes ?? [],
    lastSyncAt: c.lastSyncAt ?? null, lastHealthCheckAt: c.lastHealthCheckAt ?? null, lastError: c.lastError ?? null, settings: c.settings,
});
