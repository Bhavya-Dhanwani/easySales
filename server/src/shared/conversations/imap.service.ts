// Importing modules
import mongoose from "mongoose";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import EmailIntegration from "../models/emailIntegration.model.js";
import ProviderEvent from "../models/providerEvent.model.js";
import Conversation from "../models/conversation.model.js";
import PlatformInbox from "../models/platformInbox.model.js";
import { matchConversation } from "./events.service.js";
import { conversationFromAddress } from "./replyAddress.js";
import { detectMailServers } from "./mailServers.js";
import { decryptSecret } from "../utils/crypto.util.js";
import { assertPublicHost } from "../utils/safeFetch.util.js";
import env from "../config/env.config.js";
import logger from "../config/logger.config.js";

type Id = mongoose.Types.ObjectId;
export type ImapConfig = { host: string; port: number; user: string };
type Address = { address?: string };
type Envelope = { messageId?: string; inReplyTo?: string; from?: Address[]; to?: Address[]; cc?: Address[] };

// the subset of ImapFlow used here, so tests can swap in an in-memory inbox
export interface ImapClient {
    connect(): Promise<void>;
    logout(): Promise<void>;
    mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<{ uidValidity: bigint | number; uidNext: number }>;
    search(query: { uid: string }, opts: { uid: true }): Promise<number[] | false | undefined>;
    fetchAll(range: number[], query: { uid: true; envelope: true; size: true }, opts: { uid: true }): Promise<{ uid: number; size?: number; envelope?: Envelope }[]>;
    fetchOne(uid: string, query: { source: true }, opts: { uid: true }): Promise<{ source?: Buffer } | false | undefined>;
}

// the SSRF guard sits with the real connection (tests swap the whole client)
const realOpen = async (cfg: ImapConfig, password: string): Promise<ImapClient> => (await assertPublicHost(cfg.host, "IMAP"), new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.port === 993, auth: { user: cfg.user, pass: password },
    logger: false, connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 60_000,
}));
let open = realOpen;
export const setImapClient = (fn: typeof open | null) => { open = fn ?? realOpen; };

// smtp.gmail.com -> imap.gmail.com; Microsoft 365 / Outlook use one host for both
export function imapHostFor(smtpHost: string) {
    const h = smtpHost.toLowerCase();
    if (/(^|\.)(office365|outlook)\.com$/.test(h)) return "outlook.office365.com";
    return h.replace(/^(smtp|mail|smtpout|send)\./, "imap.");
}

const BATCH = 50;
const MAX_SIZE = 2_000_000;
const POLL_EVERY_MS = 60_000;

async function session<T>(cfg: ImapConfig, password: string, fn: (c: ImapClient, box: { uidValidity: string; uidNext: number }) => Promise<T>) {
    const client = await open(cfg, password);
    await client.connect();
    try {
        // read-only: never marks the owner's mail as read or changes anything in the mailbox
        const box = await client.mailboxOpen("INBOX", { readOnly: true });
        return await fn(client, { uidValidity: String(box.uidValidity), uidNext: box.uidNext });
    } finally {
        await client.logout().catch(() => undefined);
    }
}

// signs in at connect time and returns the current inbox position, so only mail from now on is read
export const verifyImap = (cfg: ImapConfig, password: string) =>
    session(cfg, password, async (_c, box) => ({ uidValidity: box.uidValidity, lastUid: Math.max(0, box.uidNext - 1) }));

// where a message belongs: decided from its envelope alone, before anything is downloaded
type Route = { organizationId: Id; integrationId: Id; conversationId?: Id; from: string };

/*
    Reads new inbox mail from a read position. Privacy: only envelopes are read for every new
    message; a full message is downloaded only when `route` places it in a known conversation.
    Everything else is never stored. Routed replies become provider events, the same path as
    the inbound webhook. Returns the new read position (a changed uidValidity restarts from now).
*/
async function readNew(cfg: ImapConfig, password: string, state: { uidValidity?: string | null; lastUid?: number | null }, source: string, route: (envelope: Envelope) => Promise<Route | null>) {
    return session(cfg, password, async (client, box) => {
        if (state.uidValidity !== box.uidValidity) return { uidValidity: box.uidValidity, lastUid: Math.max(0, box.uidNext - 1), read: 0, matched: 0 };
        const after = state.lastUid ?? 0;
        if (box.uidNext <= after + 1) return { uidValidity: box.uidValidity, lastUid: after, read: 0, matched: 0 };
        // "n:*" always includes the newest message, even when it is older than n
        const uids = ((await client.search({ uid: `${after + 1}:*` }, { uid: true })) || []).filter((u) => u > after).sort((a, b) => a - b).slice(0, BATCH);
        if (!uids.length) return { uidValidity: box.uidValidity, lastUid: after, read: 0, matched: 0 };

        let matched = 0;
        for (const m of await client.fetchAll(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
            if (!m.envelope || (m.size ?? 0) > MAX_SIZE) continue;
            const to = await route(m.envelope);
            if (!to) continue;
            const full = await client.fetchOne(String(m.uid), { source: true }, { uid: true });
            if (!full || !full.source) continue;
            const mail = await simpleParser(full.source);
            const auto = String(mail.headers.get("auto-submitted") ?? "no").toLowerCase();
            const references = typeof mail.references === "string" ? [mail.references] : mail.references ?? [];
            await ProviderEvent.create({
                organizationId: to.organizationId, integrationId: to.integrationId, eventId: `${source}:${box.uidValidity}:${m.uid}`, type: "inbound",
                occurredAt: mail.date ?? new Date(),
                payload: {
                    messageId: mail.messageId, from: to.from, subject: mail.subject?.slice(0, 500), text: (mail.text ?? "").slice(0, 20_000),
                    inReplyTo: mail.inReplyTo, references, autoSubmitted: auto !== "no" || Boolean(mail.headers.get("x-autoreply")),
                    conversationId: to.conversationId ? String(to.conversationId) : undefined,
                },
            }).then(() => matched++).catch((e) => { if (e.code !== 11000) throw e; });
        }
        return { uidValidity: box.uidValidity, lastUid: uids[uids.length - 1], read: uids.length, matched };
    });
}

/* ------------------------- tenant mailboxes ------------------------- */

// a workspace's own inbox: a reply to our email, or mail from one of its leads
async function pollOne(i: InstanceType<typeof EmailIntegration>) {
    const cfg = { host: i.imap!.host!, port: i.imap!.port ?? 993, user: i.smtp!.user };
    const r = await readNew(cfg, decryptSecret(i.smtp!.passwordEnc), i.imap!, `imap:${i._id}`, async (envelope) => {
        const from = envelope.from?.[0]?.address?.toLowerCase();
        if (!from || from === i.fromEmail) return null;
        const conversationId = await matchConversation(i.organizationId, { from, inReplyTo: envelope.inReplyTo });
        return conversationId ? { organizationId: i.organizationId, integrationId: i._id, conversationId, from } : null;
    });
    // $max: a slower concurrent poll can never move the position backwards
    await EmailIntegration.updateOne({ organizationId: i.organizationId, _id: i._id }, r.uidValidity !== i.imap!.uidValidity
        ? { "imap.uidValidity": r.uidValidity, "imap.lastUid": r.lastUid, "imap.lastError": null }
        : { $max: { "imap.lastUid": r.lastUid }, "imap.lastError": null });
    return r;
}

/* ------------------------- platform reply inbox ------------------------- */

// replies to platform mail are recorded under this fixed id instead of a tenant integration
export const PLATFORM_INTEGRATION_ID = new mongoose.Types.ObjectId("000000000000000000000001");

// a reply counts only when it was sent to a signed per-conversation address of ours
async function routePlatform(envelope: Envelope): Promise<Route | null> {
    const from = envelope.from?.[0]?.address?.toLowerCase();
    const addressed = [...(envelope.to ?? []), ...(envelope.cc ?? [])].map((a) => conversationFromAddress(a.address)).find(Boolean);
    if (!from || !addressed) return null;
    const conversation = await Conversation.findOne({ _id: addressed }, { organizationId: 1 }).setOptions({ crossTenant: true }).lean();
    return conversation ? { organizationId: conversation.organizationId, integrationId: PLATFORM_INTEGRATION_ID, conversationId: conversation._id, from } : null;
}

async function pollPlatformInbox() {
    if (!env.PLATFORM_REPLY_EMAIL || !env.PLATFORM_REPLY_PASSWORD) return;
    await PlatformInbox.updateOne({ key: "replies" }, { $setOnInsert: { key: "replies" } }, { upsert: true }).catch((e) => { if (e.code !== 11000) throw e; });
    // claiming this minute's poll keeps two workers off the same inbox
    const state = await PlatformInbox.findOneAndUpdate(
        { key: "replies", $or: [{ lastPolledAt: null }, { lastPolledAt: { $lt: new Date(Date.now() - POLL_EVERY_MS) } }] },
        { lastPolledAt: new Date() }, { new: true },
    );
    if (!state) return;
    try {
        const servers = await detectMailServers(env.PLATFORM_REPLY_EMAIL);
        const r = await readNew({ host: servers.imapHost, port: 993, user: env.PLATFORM_REPLY_EMAIL }, env.PLATFORM_REPLY_PASSWORD, state, "platform", routePlatform);
        await PlatformInbox.updateOne({ key: "replies" }, r.uidValidity !== state.uidValidity
            ? { uidValidity: r.uidValidity, lastUid: r.lastUid, lastError: null }
            : { $max: { lastUid: r.lastUid }, lastError: null });
        if (r.read) logger.info({ read: r.read, matched: r.matched }, "Platform reply inbox polled");
    } catch (error) {
        await PlatformInbox.updateOne({ key: "replies" }, { lastError: (error as Error).message.slice(0, 300) });
        logger.warn({ error: (error as Error).message }, "Platform reply inbox poll failed");
    }
}

// worker: each inbox at most once a minute; claiming lastPolledAt keeps two workers off the same inbox
export async function pollInboxes(max = 20) {
    await pollPlatformInbox();
    for (let n = 0; n < max; n++) {
        const i = await EmailIntegration.findOneAndUpdate(
            { "imap.enabled": true, status: "connected", $or: [{ "imap.lastPolledAt": null }, { "imap.lastPolledAt": { $lt: new Date(Date.now() - POLL_EVERY_MS) } }] },
            { "imap.lastPolledAt": new Date() },
            { sort: { "imap.lastPolledAt": 1 }, new: true },
        ).setOptions({ crossTenant: true });
        if (!i) return;
        try {
            const r = await pollOne(i);
            if (r.read) logger.info({ organizationId: String(i.organizationId), read: r.read, matched: r.matched }, "Inbox polled");
        } catch (error) {
            await EmailIntegration.updateOne({ organizationId: i.organizationId as Id, _id: i._id }, { "imap.lastError": (error as Error).message.slice(0, 300) });
            logger.warn({ organizationId: String(i.organizationId), error: (error as Error).message }, "Inbox poll failed");
        }
    }
}
