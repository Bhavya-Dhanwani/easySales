// Importing modules
import ApiError from "../utils/ApiError.util.js";

/* ------------------------------- errors ------------------------------- */

// the provider asked us to slow down; the job is retried later (not a failure of the data)
export class RateLimitedError extends ApiError {
    code = "RATE_LIMITED";
    constructor(public retryAfterSec = 30) {
        super(503, `Provider rate limit; retry in ${retryAfterSec}s`);
    }
}

// the user revoked access or the refresh token expired: only reconnecting helps
export class ReconnectRequiredError extends ApiError {
    code = "RECONNECT_REQUIRED";
    constructor(provider: string) {
        super(409, `${provider} access was revoked or expired. Reconnect the integration.`);
    }
}

export class ProviderError extends ApiError {
    code = "PROVIDER_ERROR";
    constructor(message: string, public providerStatus?: number) {
        super(502, message);
    }
}

/* -------------------------------- http -------------------------------- */

export type Http = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string>; headers: { get(name: string): string | null } }>;

let http: Http = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

// tests replace the network with in-memory provider simulators
export const setIntegrationHttp = (next: Http | null) => { http = next ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })); };

/*
    JSON request with uniform error mapping: 429 → RateLimitedError (Retry-After honoured),
    401 → ReconnectRequiredError is decided by the caller (it may refresh first), other
    non-2xx → ProviderError with a short, credential-free message.
*/
export async function request<T>(url: string, init: { method?: string; token?: string; body?: unknown; form?: Record<string, string> } = {}): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    let body: string | undefined;
    if (init.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(init.form).toString();
    } else if (init.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.body);
    }
    const res = await http(url, { method: init.method ?? "GET", headers, body });
    if (res.status === 429) throw new RateLimitedError(Number(res.headers.get("retry-after")) || 30);
    const text = await res.text();
    const data = (text ? (() => { try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; } })() : {}) as T;
    return { status: res.status, data };
}

export const ok = (s: number) => s >= 200 && s < 300;

export function fail(provider: string, what: string, status: number, data: unknown): never {
    const msg = (data as { message?: string; error?: { message?: string } | string; error_description?: string })?.message
        ?? (typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : (data as { error?: { message?: string } })?.error?.message)
        ?? (data as { error_description?: string })?.error_description ?? "";
    throw new ProviderError(`${provider} ${what} failed (${status})${msg ? `: ${String(msg).slice(0, 200)}` : ""}`, status);
}

/* ------------------------------- shapes ------------------------------- */

export interface TokenSet { accessToken: string; refreshToken?: string; expiresIn: number; accountId: string; accountLabel?: string; scopes?: string[] }

export interface NormalizedContact {
    externalId: string; email?: string; firstName?: string; lastName?: string; title?: string; phone?: string;
    companyExternalId?: string; companyName?: string; updatedAt: Date;
}
export interface NormalizedCompany { externalId: string; name: string; domain?: string; industry?: string; employees?: number; country?: string; updatedAt: Date }
export interface NormalizedDeal { name: string; stage: string; amountMinor?: number; currency?: string; contactExternalId?: string; companyExternalId?: string }
export interface Page<T> { items: T[]; next?: string }

// what a provider can do; callers check capabilities instead of assuming every adapter is alike
export interface OAuthAdapter {
    provider: string;
    scopes: string[];
    pkce: boolean;
    authorizeUrl(state: string, redirectUri: string, codeChallenge?: string): string;
    exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<TokenSet>;
    refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }>;
    revoke?(token: string): Promise<void>;
    testConnection(token: string): Promise<void>;
}

export interface CrmAdapter extends OAuthAdapter {
    searchContacts(token: string, sinceMs: number, after?: string): Promise<Page<NormalizedContact>>;
    searchCompanies(token: string, sinceMs: number, after?: string): Promise<Page<NormalizedCompany>>;
    getContact(token: string, id: string): Promise<NormalizedContact | null>;
    getCompany(token: string, id: string): Promise<NormalizedCompany | null>;
    findContactByEmail(token: string, email: string): Promise<string | null>;
    findCompanyByDomain(token: string, domain: string): Promise<string | null>;
    findDealByName(token: string, name: string): Promise<string | null>;
    upsertCompany(token: string, existingId: string | null, c: Omit<NormalizedCompany, "externalId" | "updatedAt">): Promise<string>;
    upsertContact(token: string, existingId: string | null, c: Omit<NormalizedContact, "externalId" | "updatedAt">): Promise<string>;
    upsertDeal(token: string, existingId: string | null, d: NormalizedDeal, onlyStageAndAmount: boolean): Promise<string>;
    // our stage → provider stage, and back (null = no equivalent)
    stageOut(stage: string): string | null;
    stageIn(providerStage: string): string | null;
}

export interface BusyInterval { start: Date; end: Date }
export interface CalendarAdapter extends OAuthAdapter {
    freeBusy(token: string, from: Date, to: Date, timezone: string): Promise<BusyInterval[]>;
    createEvent(token: string, e: { id: string; start: Date; end: Date; timezone: string; summary: string; description: string; attendees: string[]; sendInvites: boolean }): Promise<{ id: string; link?: string; created: boolean }>;
    updateEvent(token: string, id: string, e: { start: Date; end: Date; timezone: string; sendInvites: boolean }): Promise<void>;
    deleteEvent(token: string, id: string, sendInvites: boolean): Promise<void>;
    getEvent(token: string, id: string): Promise<{ status: "confirmed" | "tentative" | "cancelled"; start: Date; end: Date } | null>;
}
