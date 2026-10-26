// Build dist/: one ESM and one CJS bundle per entry point (dependencies stay
// external), plus declarations from tsc, re-exported for both conditions.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const ENTRIES = ["index"];

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const [format, ext] of [
  ["esm", "js"],
  ["cjs", "cjs"],
]) {
  await build({
    entryPoints: ENTRIES.map((name) => ({ in: `src/${name}.ts`, out: name })),
    outdir: "dist",
    outExtension: { ".js": `.${ext}` },
    bundle: true,
    packages: "external",
    format,
    platform: "neutral",
    target: "es2022",
    sourcemap: true,
    logLevel: "warning",
  });
}
execFileSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit" });
for (const name of ENTRIES) {
  const reexport = `export * from "./types/${name}.js";\n`;
  writeFileSync(`dist/${name}.d.ts`, reexport);
  writeFileSync(`dist/${name}.d.cts`, reexport);
}
