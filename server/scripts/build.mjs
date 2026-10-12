// Production build: strips TypeScript with esbuild (file by file, no bundling) into dist/.
// Type checking is `npm run typecheck`, which CI runs; tsc itself needs > 2 GB of memory for this
// codebase (LangChain types), more than a small server has.
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts") ? [path] : [];
});

rmSync("dist", { recursive: true, force: true });
await build({
    entryPoints: ["server.ts", "worker.ts", "migrate.ts", ...sources("src")],
    outdir: "dist", outbase: ".",
    format: "esm", platform: "node", target: "node22",
    sourcemap: true, logLevel: "warning",
});
console.log("built dist/");
