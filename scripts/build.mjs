import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const flightRules = dirname(require.resolve("@good-ground-collective/flight-rules/package.json"));

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: { gather: "src/gather.ts", post: "src/post.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "none",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});

const home = join("dist", "flight-rules");
mkdirSync(home, { recursive: true });
cpSync(join(flightRules, "docs"), join(home, "docs"), {
  recursive: true,
  filter: (src) => !/[\\/](evidence|validation)([\\/]|$)/.test(src),
});
cpSync(join(flightRules, "contracts"), join(home, "contracts"), { recursive: true });
cpSync("prompts", join("dist", "prompts"), { recursive: true });
cpSync(join(flightRules, "LICENSE"), join(home, "LICENSE"));
cpSync(join(flightRules, "package.json"), join(home, "package.json"));
