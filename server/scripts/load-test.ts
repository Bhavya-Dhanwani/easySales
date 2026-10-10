/*
    Minimal load test: N concurrent clients hit each path for D seconds, then the script
    prints throughput, latency percentiles and error rate, and exits non-zero when a
    release target is missed.

    BASE_URL=http://localhost:5000 TOKEN=<access token> ORG=<organization id> npx tsx scripts/load-test.ts
    Optional: PATHS=/api/health/ready,/api/v1/leads CONCURRENCY=20 SECONDS=20 P95_MS=300 MAX_ERROR_RATE=0.01
    Run it against staging (or local), never against production with real tenants.
*/
const BASE = process.env.BASE_URL ?? "http://localhost:5000";
const PATHS = (process.env.PATHS ?? "/api/health/ready,/api/v1/leads?limit=20,/api/v1/dashboard").split(",");
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const SECONDS = Number(process.env.SECONDS ?? 20);
const P95_MS = Number(process.env.P95_MS ?? 300);
const MAX_ERROR_RATE = Number(process.env.MAX_ERROR_RATE ?? 0.01);
const headers: Record<string, string> = {};
if (process.env.TOKEN) headers.Authorization = `Bearer ${process.env.TOKEN}`;
if (process.env.ORG) headers["X-Organization-Id"] = process.env.ORG;

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;

async function hammer(path: string) {
    const ms: number[] = [];
    const codes = new Map<number, number>();
    const end = Date.now() + SECONDS * 1000;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (Date.now() < end) {
            const t = performance.now();
            let status = 0;
            try {
                const r = await fetch(BASE + path, { headers });
                await r.arrayBuffer();
                status = r.status;
            } catch {
                status = 0;
            }
            ms.push(performance.now() - t);
            codes.set(status, (codes.get(status) ?? 0) + 1);
        }
    }));
    ms.sort((a, b) => a - b);
    const errors = [...codes].filter(([c]) => c === 0 || c >= 500 || c === 429).reduce((a, [, n]) => a + n, 0);
    return { path, requests: ms.length, rps: Math.round(ms.length / SECONDS), p50: Math.round(pct(ms, 50)), p95: Math.round(pct(ms, 95)), p99: Math.round(pct(ms, 99)), errorRate: +(errors / ms.length).toFixed(4), codes: Object.fromEntries(codes) };
}

let failed = false;
for (const path of PATHS) {
    const r = await hammer(path);
    const ok = r.p95 <= P95_MS && r.errorRate <= MAX_ERROR_RATE;
    failed ||= !ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${JSON.stringify(r)}`);
}
console.log(`targets: p95 <= ${P95_MS} ms, error rate <= ${MAX_ERROR_RATE}, ${CONCURRENCY} concurrent clients, ${SECONDS}s per path`);
process.exit(failed ? 1 : 0);
