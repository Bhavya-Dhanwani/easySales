// Importing modules
import mongoose from "mongoose";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import EmailIntegration from "../models/emailIntegration.model.js";
import ProviderEvent from "../models/providerEvent.model.js";
import { matchConversation } from "./events.service.js";
import { decryptSecret } from "../utils/crypto.util.js";
import { assertPublicHost } from "../utils/safeFetch.util.js";
import logger from "../config/logger.config.js";

type Id = mongoose.Types.ObjectId;
export type ImapConfig = { host: string; port: number; user: string };

// the subset of ImapFlow used here, so tests can swap in an in-memory inbox
export interface ImapClient {
    connect(): Promise<void>;
    logout(): Promise<void>;
    mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<{ uidValidity: bigint | number; uidNext: number }>;
    search(query: { uid: string }, opts: { uid: true }): Promise<number[] | false | undefined>;
    fetchAll(range: number[], query: { uid: true; envelope: true; size: true }, opts: { uid: true }): Promise<{ uid: number; size?: number; envelope?: { messageId?: string; inReplyTo?: string; from?: { address?: string }[] } }[]>;
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

/*
    Reads new inbox mail for one account. Privacy: only envelopes are read for every new
    message; a full message is downloaded only when it belongs to a known conversation
    (a reply to our email or from a lead's address). Everything else is never stored.
    Matched replies become provider events, the same path as the inbound webhook.
*/
async function pollOne(i: InstanceType<typeof EmailIntegration>) {
    const cfg = { host: i.imap!.host!, port: i.imap!.port ?? 993, user: i.smtp!.user };
    return session(cfg, decryptSecret(i.smtp!.passwordEnc), async (client, box) => {
        if (i.imap!.uidValidity !== box.uidValidity) {
            await EmailIntegration.updateOne({ organizationId: i.organizationId, _id: i._id }, { "imap.uidValidity": box.uidValidity, "imap.lastUid": Math.max(0, box.uidNext - 1), "imap.lastError": null });
            return { read: 0, matched: 0, reset: true };
        }
        const after = i.imap!.lastUid ?? 0;
        if (box.uidNext <= after + 1) return { read: 0, matched: 0 };
        // "n:*" always includes the newest message, even when it is older than n
        const uids = ((await client.search({ uid: `${after + 1}:*` }, { uid: true })) || []).filter((u) => u > after).sort((a, b) => a - b).slice(0, BATCH);
        if (!uids.length) return { read: 0, matched: 0 };

        let matched = 0;
        for (const m of await client.fetchAll(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
            const from = m.envelope?.from?.[0]?.address?.toLowerCase();
            if (!from || from === i.fromEmail || (m.size ?? 0) > MAX_SIZE) continue;
            const conversationId = await matchConversation(i.organizationId, { from, inReplyTo: m.envelope?.inReplyTo });
            if (!conversationId) continue;
            const full = await client.fetchOne(String(m.uid), { source: true }, { uid: true });
            if (!full || !full.source) continue;
            const mail = await simpleParser(full.source);
            const auto = String(mail.headers.get("auto-submitted") ?? "no").toLowerCase();
            const references = typeof mail.references === "string" ? [mail.references] : mail.references ?? [];
            await ProviderEvent.create({
                organizationId: i.organizationId, integrationId: i._id, eventId: `imap:${box.uidValidity}:${m.uid}`, type: "inbound",
                occurredAt: mail.date ?? new Date(),
                payload: {
                    messageId: mail.messageId, from, subject: mail.subject?.slice(0, 500), text: (mail.text ?? "").slice(0, 20_000),
                    inReplyTo: mail.inReplyTo, references, autoSubmitted: auto !== "no" || Boolean(mail.headers.get("x-autoreply")),
                },
            }).then(() => matched++).catch((e) => { if (e.code !== 11000) throw e; });
        }
        // $max: a slower concurrent poll can never move the position backwards
        await EmailIntegration.updateOne({ organizationId: i.organizationId, _id: i._id }, { $max: { "imap.lastUid": uids[uids.length - 1] }, "imap.lastError": null });
        return { read: uids.length, matched };
    });
}

// worker: each account at most once a minute; claiming lastPolledAt keeps two workers off the same inbox
export async function pollInboxes(max = 20) {
    for (let n = 0; n < max; n++) {
        const i = await EmailIntegration.findOneAndUpdate(
            { "imap.enabled": true, status: "connected", $or: [{ "imap.lastPolledAt": null }, { "imap.lastPolledAt": { $lt: new Date(Date.now() - POLL_EVERY_MS) } }] },
            { "imap.lastPolledAt": new Date() },
            { sort: { "imap.lastPolledAt": 1 }, new: true },
        ).setOptions({ crossTenant: true });
        if (!i) return;
        try {
            const r = await pollOne(i);
            if (r.read) logger.info({ organizationId: String(i.organizationId), ...r }, "Inbox polled");
        } catch (error) {
            await EmailIntegration.updateOne({ organizationId: i.organizationId as Id, _id: i._id }, { "imap.lastError": (error as Error).message.slice(0, 300) });
            logger.warn({ organizationId: String(i.organizationId), error: (error as Error).message }, "Inbox poll failed");
        }
    }
}
