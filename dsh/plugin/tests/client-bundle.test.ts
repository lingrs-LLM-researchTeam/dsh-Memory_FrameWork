import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

it("registers a browser factory with only platform-provided external modules", () => {
  const require = createRequire(import.meta.url);
  const requested: string[] = [];
  const registrations: string[] = [];
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: {
      __ModuleLoader__: {
        load(entry: { id: string; factory: (require: (id: string) => unknown) => { apply: unknown } }) {
          registrations.push(entry.id);
          const exports = entry.factory((id) => { requested.push(id); return require(id) });
          expect(typeof exports.apply).toBe("function");
        },
      },
    },
    URL, TextEncoder, TextDecoder, console,
  });
  expect(registrations).toEqual(["dsh-memory-framework"]);
  expect(requested.every(id => ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis"].includes(id))).toBe(true);
});
