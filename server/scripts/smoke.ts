/*
    Post-deploy smoke test: BASE_URL=https://staging.example.com npx tsx scripts/smoke.ts
    Exits non-zero (blocking promotion) if the release is unhealthy, insecure or broken.
    Optional SMOKE_TOKEN (a staging test user's access token) also checks an authenticated route.
*/
const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
if (!BASE) { console.error("Set BASE_URL"); process.exit(2); }

const checks: [string, () => Promise<boolean | string>][] = [
    ["ready: database and worker up", async () => (await fetch(`${BASE}/api/health/ready`)).status === 200],
    ["the app shell is served", async () => { const r = await fetch(`${BASE}/`); return r.status === 200 && (await r.text()).includes("<div id=\"root\""); }],
    ["private API refuses anonymous callers", async () => (await fetch(`${BASE}/api/v1/leads`)).status === 401],
    ["unknown API routes answer JSON 404", async () => { const r = await fetch(`${BASE}/api/does-not-exist`); return r.status === 404 && (r.headers.get("content-type") ?? "").includes("json"); }],
    ["security headers present", async () => { const r = await fetch(`${BASE}/api/health`); return Boolean(r.headers.get("strict-transport-security") || BASE.startsWith("http://")) && r.headers.get("x-content-type-options") === "nosniff"; }],
    ["requests are traced", async () => Boolean((await fetch(`${BASE}/api/health`)).headers.get("x-request-id"))],
    ["webhooks reject unsigned payloads", async () => [401, 503].includes((await fetch(`${BASE}/api/webhooks/billing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status)],
    ["authenticated session works", async () => {
        if (!process.env.SMOKE_TOKEN) return "skipped (no SMOKE_TOKEN)";
        return (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${process.env.SMOKE_TOKEN}` } })).status === 200;
    }],
];

let failed = 0;
for (const [name, fn] of checks) {
    let r: boolean | string;
    try { r = await fn(); } catch (e) { r = false; console.error(`  ${(e as Error).message}`); }
    const ok = r === true || typeof r === "string";
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${typeof r === "string" ? ` · ${r}` : ""}`);
}
console.log(failed ? `\nSMOKE FAILED (${failed}) against ${BASE}` : `\nSMOKE PASSED against ${BASE}`);
process.exit(failed ? 1 : 0);
