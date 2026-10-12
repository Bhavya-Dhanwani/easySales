// Importing modules
import dns from "node:dns/promises";

export type MailServers = { smtpHost: string; smtpPort: number; secure: boolean; imapHost: string; provider: string };

// well-known mailbox providers by address domain or by the domain's MX host
const KNOWN: { match: RegExp; servers: MailServers }[] = [
    { match: /(^|\.)(gmail\.com|googlemail\.com|google\.com)$/, servers: { provider: "Gmail / Google Workspace", smtpHost: "smtp.gmail.com", smtpPort: 587, secure: false, imapHost: "imap.gmail.com" } },
    { match: /(^|\.)(outlook\.com|hotmail\.com|live\.com|msn\.com|office365\.com|outlook\.office365\.com|protection\.outlook\.com)$/, servers: { provider: "Outlook / Microsoft 365", smtpHost: "smtp.office365.com", smtpPort: 587, secure: false, imapHost: "outlook.office365.com" } },
    { match: /(^|\.)(yahoo\.com|yahoo\.co\.in|ymail\.com|yahoodns\.net)$/, servers: { provider: "Yahoo Mail", smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, secure: true, imapHost: "imap.mail.yahoo.com" } },
    { match: /(^|\.)(icloud\.com|me\.com|mac\.com)$/, servers: { provider: "iCloud Mail", smtpHost: "smtp.mail.me.com", smtpPort: 587, secure: false, imapHost: "imap.mail.me.com" } },
    { match: /(^|\.)(zoho\.in|zohomail\.in)$/, servers: { provider: "Zoho Mail (India)", smtpHost: "smtp.zoho.in", smtpPort: 465, secure: true, imapHost: "imap.zoho.in" } },
    { match: /(^|\.)(zoho\.com|zohomail\.com)$/, servers: { provider: "Zoho Mail", smtpHost: "smtp.zoho.com", smtpPort: 465, secure: true, imapHost: "imap.zoho.com" } },
    { match: /(^|\.)secureserver\.net$/, servers: { provider: "GoDaddy", smtpHost: "smtpout.secureserver.net", smtpPort: 465, secure: true, imapHost: "imap.secureserver.net" } },
    { match: /(^|\.)(hostinger\.com|hostinger\.in)$/, servers: { provider: "Hostinger", smtpHost: "smtp.hostinger.com", smtpPort: 465, secure: true, imapHost: "imap.hostinger.com" } },
    { match: /(^|\.)titan\.email$/, servers: { provider: "Titan", smtpHost: "smtp.titan.email", smtpPort: 465, secure: true, imapHost: "imap.titan.email" } },
];

let resolveMx: (domain: string) => Promise<{ exchange: string; priority: number }[]> = (d) => dns.resolveMx(d);
export const setMxResolver = (fn: typeof resolveMx | null) => { resolveMx = fn ?? ((d) => dns.resolveMx(d)); };

/*
    So users only type their email and app password: the address's domain, else the
    domain's mail exchanger (a company domain hosted by Google, Microsoft, Zoho...), else the
    common smtp./imap. names on the domain itself.
*/
export async function detectMailServers(email: string): Promise<MailServers> {
    const domain = email.split("@").pop()!.toLowerCase();
    const direct = KNOWN.find((k) => k.match.test(domain));
    if (direct) return direct.servers;
    const mx = await resolveMx(domain).catch(() => []);
    for (const { exchange } of mx.sort((a, b) => a.priority - b.priority)) {
        const host = exchange.toLowerCase().replace(/\.$/, "");
        const known = KNOWN.find((k) => k.match.test(host) || (k.servers.provider.startsWith("Gmail") && /(^|\.)(googlemail|google)\.com$/.test(host)));
        if (known) return known.servers;
    }
    return { provider: domain, smtpHost: `smtp.${domain}`, smtpPort: 587, secure: false, imapHost: `imap.${domain}` };
}
