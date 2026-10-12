// Importing modules
import { createHmac, timingSafeEqual } from "node:crypto";
import env from "../config/env.config.js";
import { platformReplyInbox } from "../../providers/brevo.js";

/*
    Replies to mail sent from the platform address go to one shared inbox, addressed per
    conversation: replies+r-<conversationId>.<signature>@domain (plus addressing, supported by
    Gmail, Outlook and most providers). The signature means nobody can drop a fake "reply"
    into someone else's conversation by guessing an id. Lowercase hex: mail systems may lowercase addresses.
*/
const sign = (conversationId: string) =>
    createHmac("sha256", `reply-address:${env.ENCRYPTION_KEY}`).update(conversationId.toLowerCase()).digest("hex").slice(0, 16);

export function replyAddressFor(conversationId: string) {
    const [local, domain] = platformReplyInbox()!.email.split("@");
    return `${local}+r-${conversationId}.${sign(conversationId)}@${domain}`;
}

// the conversation a reply belongs to, if the address is one of ours and its signature holds
export function conversationFromAddress(address: string | undefined) {
    const inbox = platformReplyInbox();
    if (!address || !inbox) return null;
    const [local, domain] = inbox.email.toLowerCase().split("@");
    const m = address.toLowerCase().match(/^([^+@]+)\+r-([0-9a-f]{24})\.([0-9a-f]{16})@(.+)$/);
    if (!m || m[1] !== local || m[4] !== domain) return null;
    const ok = timingSafeEqual(Buffer.from(m[3]), Buffer.from(sign(m[2])));
    return ok ? m[2] : null;
}
