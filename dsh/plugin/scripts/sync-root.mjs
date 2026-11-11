import { cpSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginDir, "..", "..");

if (existsSync(join(repoRoot, "pyproject.toml"))) {
  const rootLib = join(repoRoot, "lib");
  mkdirSync(rootLib, { recursive: true });
  cpSync(join(pluginDir, "lib"), rootLib, { recursive: true, force: true });
  copyFileSync(
    join(pluginDir, "cordis.patch.yml"),
    join(repoRoot, "cordis.patch.yml"),
  );
}
