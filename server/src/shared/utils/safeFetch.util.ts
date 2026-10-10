// Importing modules
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

// true for loopback, private, link-local, CGNAT, multicast and other non-public ranges
export function isPrivateAddress(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split(".").map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 192 && b === 0) ||
            (a === 198 && (b === 18 || b === 19));
    }
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        if (v === "::" || v === "::1") return true;
        const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateAddress(mapped[1]);
        return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
    }
    return true;
}

// validates a user/AI-supplied URL before any network access
export function assertPublicHttpUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("Invalid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are allowed");
    if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
    if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Non-standard ports are not allowed");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
        throw new Error("Internal hostnames are not allowed");
    }
    if (net.isIP(host) && isPrivateAddress(host)) throw new Error("Private addresses are not allowed");
    return url;
}

// DNS lookup that refuses private answers at connect time (defeats DNS rebinding)
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = addresses as dns.LookupAddress[];
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad || list.length === 0) return callback(new Error(`Blocked address for ${hostname}`), "", 4);
        if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
        callback(null, list[0].address, list[0].family);
    });
};

export interface FetchedPage {
    url: string;
    status: number;
    contentType: string;
    body: string;
}

function requestOnce(url: URL): Promise<{ status: number; location?: string; contentType: string; body: string }> {
    return new Promise((resolve, reject) => {
        const client = url.protocol === "https:" ? https : http;
        const req = client.request(url, {
            method: "GET",
            lookup: guardedLookup,
            timeout: TIMEOUT_MS,
            headers: { "user-agent": "easySalesResearchBot/1.0", accept: "text/html,text/plain;q=0.9" },
        }, (res) => {
            const status = res.statusCode ?? 0;
            const contentType = String(res.headers["content-type"] ?? "");
            if (status >= 300 && status < 400) {
                res.resume();
                return resolve({ status, location: res.headers.location, contentType, body: "" });
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BYTES) {
                    req.destroy();
                    return resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") });
                }
                chunks.push(chunk);
            });
            res.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.on("error", reject);
        req.end();
    });
}

/*
    Fetches a public web page for research with SSRF protection: http(s) only, standard
    ports, public IPs only (checked at connect time), bounded redirects, size and time.
*/
export async function safeFetch(raw: string): Promise<FetchedPage> {
    let url = assertPublicHttpUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await requestOnce(url);
        if (res.location && res.status >= 300 && res.status < 400) {
            url = assertPublicHttpUrl(new URL(res.location, url).toString());
            continue;
        }
        if (!/text\/html|text\/plain|application\/xhtml/.test(res.contentType)) {
            throw new Error(`Unsupported content type: ${res.contentType || "unknown"}`);
        }
        return { url: url.toString(), status: res.status, contentType: res.contentType, body: res.body };
    }
    throw new Error("Too many redirects");
}

// reduces HTML to readable text (scripts, styles and markup removed) with a length cap
export function htmlToText(html: string, maxChars = 12_000) {
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
    const description = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "";
    const text = html
        .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim();
    return { title, description, text: text.slice(0, maxChars) };
}
