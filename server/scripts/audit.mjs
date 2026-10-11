// npm audit that fails on every advisory except the reviewed ones in audit-allowlist.json.
// An entry stops working after its reviewBy date, and a stale entry (advisory gone) fails too, so it gets removed.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

let out;
try { out = execSync("npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }); }
catch (error) { out = error.stdout; } // npm audit exits non-zero when anything is found
const report = JSON.parse(out);
const allow = JSON.parse(readFileSync(new URL("../audit-allowlist.json", import.meta.url), "utf8"));
const today = new Date().toISOString().slice(0, 10);

const found = new Map(); // advisory id -> { package, severity, title }
for (const v of Object.values(report.vulnerabilities ?? {}))
    for (const via of v.via) if (typeof via === "object") found.set(via.url.split("/").pop(), { package: via.name, severity: via.severity, title: via.title });

const problems = [];
for (const [id, a] of found) {
    const entry = allow.find((e) => e.id === id);
    if (!entry) problems.push(`${a.severity} ${id} in ${a.package}: ${a.title}`);
    else if (entry.reviewBy < today) problems.push(`allowlist entry ${id} expired on ${entry.reviewBy}: review it again`);
    else console.log(`allowed until ${entry.reviewBy}: ${id} (${a.package}) — ${entry.reason}`);
}
for (const e of allow) if (!found.has(e.id)) problems.push(`allowlist entry ${e.id} is no longer needed: remove it from audit-allowlist.json`);

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`audit ok: ${found.size} advisory(ies), all reviewed`);
