import { defineConfig } from "tsdown";
import { resolve } from "node:path";
const baseline = (name: string) => ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis"].includes(name);
export default defineConfig([
  {
    entry: [resolve(".compiled/index.js")],
    format: "esm",
    platform: "node",
    fixedExtension: false,
    dts: false,
    outDir: "lib",
    clean: false,
  },
  {
    entry: [resolve(".compiled/client.js")],
    format: "cjs",
    platform: "browser",
    target: "es2022",
    dts: false,
    outDir: "lib",
    clean: false,
    define: { "process.env.NODE_ENV": '"production"' },
    deps: { neverBundle: baseline, alwaysBundle: name => !baseline(name) },
    outputOptions: {
      entryFileNames: "client.js",
      banner: 'window.__ModuleLoader__.load({ id: "dsh-memory-framework", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
]);
