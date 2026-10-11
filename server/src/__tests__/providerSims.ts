// In-memory stand-ins for the HubSpot and Google APIs, at the HTTP boundary. The real adapter
// code (URLs, payloads, pagination, error mapping) runs against them unchanged.
import type { Http } from "../shared/integrations/core.js";

type Obj = { id: string; properties: Record<string, string>; updatedAt: number };

export function createSims() {
    const hs = {
        portal: "9001", access: "hs-access-1", refresh: "hs-refresh-1", revoked: false, pageSize: 2,
        contacts: new Map<string, Obj>(), companies: new Map<string, Obj>(), deals: new Map<string, Obj>(),
        next: 100, calls: [] as string[],
        // test hooks: fail a route once with a status, or perform the write then "time out"
        failOnce: new Map<string, number>(), lostResponseOnce: new Set<string>(),
    };
    const g = {
        email: "owner@studio.test", access: "g-access-1", refresh: "g-refresh-1", revoked: false,
        busy: [] as { start: string; end: string }[], events: new Map<string, { id: string; status: string; start: string; end: string; attendees: string[] }>(),
        failCreateOnce: false, calls: [] as string[],
    };
    const put = (store: Map<string, Obj>, props: Record<string, string>, id = String(hs.next++)) => {
        const o = { id, properties: { ...props }, updatedAt: Date.now() };
        store.set(id, o);
        return o;
    };
    const iso = (o: Obj) => ({ id: o.id, properties: { ...o.properties, lastmodifieddate: new Date(o.updatedAt).toISOString(), hs_lastmodifieddate: new Date(o.updatedAt).toISOString() }, updatedAt: new Date(o.updatedAt).toISOString() });

    const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
        status, json: async () => body, text: async () => (body === null ? "" : JSON.stringify(body)), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    });

    const http: Http = async (url, init) => {
        const u = new URL(url);
        const method = init.method ?? "GET";
        const auth = init.headers?.Authorization?.replace("Bearer ", "");
        const body = init.body && init.headers?.["Content-Type"] === "application/json" ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body ?? ""));
        const key = `${method} ${u.hostname}${u.pathname}`;
        if (hs.failOnce.has(key)) { const s = hs.failOnce.get(key)!; hs.failOnce.delete(key); return res(s, { message: "simulated failure" }, s === 429 ? { "retry-after": "1" } : {}); }

        /* ---------------- HubSpot ---------------- */
        if (u.hostname === "api.hubapi.com") {
            hs.calls.push(key);
            if (u.pathname === "/oauth/v1/token") {
                if (body.grant_type === "authorization_code") return body.code === "good-code" ? res(200, { access_token: hs.access, refresh_token: hs.refresh, expires_in: 1800 }) : res(400, { status: "BAD_AUTH_CODE" });
                if (hs.revoked || body.refresh_token !== hs.refresh) return res(400, { status: "BAD_REFRESH_TOKEN", message: "invalid refresh token" });
                hs.access = `hs-access-${hs.next++}`;
                return res(200, { access_token: hs.access, refresh_token: hs.refresh, expires_in: 1800 });
            }
            if (u.pathname.startsWith("/oauth/v1/access-tokens/")) return res(200, { hub_id: Number(hs.portal), hub_domain: "studio.hubspot.test", scopes: ["crm.objects.contacts.read"] });
            if (u.pathname.startsWith("/oauth/v1/refresh-tokens/") && method === "DELETE") { hs.revoked = true; return res(204, null); }
            if (auth !== hs.access) return res(401, { message: "expired token" });
            const m = /^\/crm\/v3\/objects\/(contacts|companies|deals)(?:\/(search|[^/]+))?$/.exec(u.pathname);
            if (!m) return res(404, { message: "no route" });
            const store = hs[m[1] as "contacts" | "companies" | "deals"];
            if (m[2] === "search") {
                const f = body.filterGroups[0].filters[0];
                let items = [...store.values()].sort((a, b) => a.updatedAt - b.updatedAt);
                items = f.operator === "GTE" ? items.filter((o) => o.updatedAt >= Number(f.value)) : items.filter((o) => (o.properties[f.propertyName] ?? "").toLowerCase() === String(f.value).toLowerCase());
                const start = Number(body.after ?? 0);
                const page = items.slice(start, start + (f.operator === "GTE" ? hs.pageSize : 1));
                return res(200, { results: page.map(iso), ...(start + page.length < items.length && f.operator === "GTE" ? { paging: { next: { after: String(start + page.length) } } } : {}) });
            }
            if (!m[2] && method === "GET") return res(200, { results: [...store.values()].slice(0, 1).map(iso) });
            if (!m[2] && method === "POST") {
                if (m[1] === "contacts") {
                    const dup = [...store.values()].find((o) => o.properties.email && o.properties.email === body.properties.email);
                    if (dup) return res(409, { message: `Contact already exists. Existing ID: ${dup.id}` });
                }
                const o = put(store, { ...body.properties, ...(body.associations?.[0] ? { associatedcompanyid: body.associations.find((a: { types: { associationTypeId: number }[] }) => a.types[0].associationTypeId === 279)?.to.id ?? "" } : {}) });
                if (hs.lostResponseOnce.has(m[1])) { hs.lostResponseOnce.delete(m[1]); throw new Error("socket hang up"); }
                return res(201, iso(o));
            }
            const o = store.get(m[2]!);
            if (!o) return res(404, { message: "not found" });
            if (method === "GET") return res(200, iso(o));
            if (method === "PATCH") { Object.assign(o.properties, body.properties); o.updatedAt = Date.now(); return res(200, iso(o)); }
        }

        /* ---------------- Google ---------------- */
        if (u.hostname === "oauth2.googleapis.com") {
            g.calls.push(key);
            if (u.pathname === "/token") {
                if (body.grant_type === "authorization_code") return body.code === "good-code" && body.code_verifier ? res(200, { access_token: g.access, refresh_token: g.refresh, expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar.events" }) : res(400, { error: "invalid_grant" });
                if (g.revoked) return res(400, { error: "invalid_grant" });
                return res(200, { access_token: g.access, expires_in: 3600 });
            }
            if (u.pathname === "/revoke") { g.revoked = true; return res(200, {}); }
        }
        if (u.hostname === "openidconnect.googleapis.com") return auth === g.access ? res(200, { email: g.email, sub: "1" }) : res(401, {});
        if (u.hostname === "www.googleapis.com") {
            g.calls.push(key);
            if (auth !== g.access) return res(401, { error: { message: "invalid credentials" } });
            // like Google: every confirmed event on the calendar is busy time
            if (u.pathname === "/calendar/v3/freeBusy") return res(200, { calendars: { primary: { busy: [...g.busy, ...[...g.events.values()].filter((e) => e.status !== "cancelled").map((e) => ({ start: e.start, end: e.end }))] } } });
            if (u.pathname === "/calendar/v3/calendars/primary/events" && method === "GET") return res(200, { items: [] });
            if (u.pathname === "/calendar/v3/calendars/primary/events" && method === "POST") {
                if (g.events.has(body.id)) return res(409, { error: { message: "The requested identifier already exists." } });
                g.events.set(body.id, { id: body.id, status: "confirmed", start: body.start.dateTime, end: body.end.dateTime, attendees: body.attendees.map((a: { email: string }) => a.email) });
                if (g.failCreateOnce) { g.failCreateOnce = false; throw new Error("socket hang up"); }
                return res(200, { id: body.id, hangoutLink: `https://meet.google.com/${body.id.slice(2, 12)}` });
            }
            const em = /^\/calendar\/v3\/calendars\/primary\/events\/(.+)$/.exec(u.pathname);
            if (em) {
                const e = g.events.get(decodeURIComponent(em[1]));
                if (!e) return res(404, { error: { message: "Not Found" } });
                if (method === "GET") return res(200, { status: e.status, start: { dateTime: e.start }, end: { dateTime: e.end } });
                if (method === "PATCH") { e.start = body.start.dateTime; e.end = body.end.dateTime; return res(200, {}); }
                if (method === "DELETE") { e.status = "cancelled"; return res(204, null); }
            }
        }
        return res(404, { message: `sim: no route for ${key}` });
    };
    return { hs, g, http, put: (kind: "contacts" | "companies", props: Record<string, string>) => put(hs[kind], props) };
}
