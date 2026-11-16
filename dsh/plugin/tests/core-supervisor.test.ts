import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePythonRuntime } from "../src/core-supervisor.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const exec = vi.mocked(execFileSync);
const temporaryDirs: string[] = [];
const pythonIn = (root: string) =>
  join(
    root,
    ...(process.platform === "win32"
      ? ["Scripts", "python.exe"]
      : ["bin", "python"]),
  );
const write = (path: string, content = "") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mf-runtime-"));
  temporaryDirs.push(root);
  const source = join(root, "plugin");
  const data = join(root, "data");
  const python = pythonIn(join(data, "runtime"));
  const stamp = join(data, "runtime", ".wheel-stamp");
  const core = join(source, "dsh", "core", "memory_framework", "__init__.py");
  const shared = join(
    source,
    "shared",
    "memory_framework_shared",
    "__init__.py",
  );
  write(join(source, "pyproject.toml"), '[project]\nversion = "0.3.2"\n');
  write(core, "# core revision one\n");
  write(shared, "# shared revision one\n");
  write(python);
  return { root, source, data, python, stamp, core, shared };
}
const installCalls = () =>
  exec.mock.calls.filter(([, args]) => args?.[1] === "pip");

beforeEach(() => {
  exec.mockReset();
  exec.mockReturnValue(Buffer.alloc(0));
});
afterEach(() => {
  for (const dir of temporaryDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("source Python runtime upgrades", () => {
  it("migrates the old source stamp once and reuses unchanged installed source", () => {
    const f = fixture();
    write(f.stamp, "source-editable");
    expect(resolvePythonRuntime(f.data, f.source)).toBe(f.python);
    expect(installCalls()).toHaveLength(1);
    expect(installCalls()[0][1]).toEqual(["-m", "pip", "install", f.source]);
    expect(readFileSync(f.stamp, "utf8")).toMatch(
      /^source-sha256:[a-f0-9]{64}$/,
    );
    resolvePythonRuntime(f.data, f.source);
    expect(installCalls()).toHaveLength(1);
  });

  it("refreshes changed core, shared algorithms and metadata without a version bump", () => {
    const f = fixture();
    resolvePythonRuntime(f.data, f.source);
    for (const path of [f.core, f.shared, join(f.source, "pyproject.toml")]) {
      const oldStamp = readFileSync(f.stamp, "utf8");
      write(path, readFileSync(path, "utf8") + "\n# updated source\n");
      resolvePythonRuntime(f.data, f.source);
      expect(readFileSync(f.stamp, "utf8")).not.toBe(oldStamp);
    }
    expect(installCalls()).toHaveLength(4);
  });

  it("tracks added and removed Python modules but ignores bytecode and unrelated files", () => {
    const f = fixture();
    resolvePythonRuntime(f.data, f.source);
    const extra = join(dirname(f.core), "nested", "extra.py");
    write(extra, "# new module\n");
    resolvePythonRuntime(f.data, f.source);
    rmSync(extra);
    resolvePythonRuntime(f.data, f.source);
    write(
      join(dirname(f.core), "__pycache__", "generated.py"),
      "# generated\n",
    );
    write(join(dirname(f.core), "module.pyc"), "bytecode");
    write(join(f.source, "README.md"), "documentation only");
    resolvePythonRuntime(f.data, f.source);
    expect(installCalls()).toHaveLength(3);
  });

  it("does not stamp a failed install and retries it on the next resolution", () => {
    const f = fixture();
    write(f.stamp, "source-editable");
    exec.mockImplementationOnce(() => {
      throw new Error("pip failed");
    });
    expect(() => resolvePythonRuntime(f.data, f.source)).toThrow("pip failed");
    expect(readFileSync(f.stamp, "utf8")).toBe("source-editable");
    resolvePythonRuntime(f.data, f.source);
    expect(installCalls()).toHaveLength(2);
    expect(readFileSync(f.stamp, "utf8")).toMatch(/^source-sha256:/);
  });

  it("repairs a matching stamp when the managed runtime can no longer import", () => {
    const f = fixture();
    resolvePythonRuntime(f.data, f.source);
    exec.mockImplementationOnce(() => {
      throw new Error("missing module");
    });
    resolvePythonRuntime(f.data, f.source);
    expect(installCalls()).toHaveLength(2);
  });

  it("only reuses a checkout virtualenv when both modules come from that checkout", () => {
    const f = fixture();
    const localPython = pythonIn(join(f.source, ".venv"));
    write(localPython);
    expect(resolvePythonRuntime(f.data, f.source)).toBe(localPython);
    expect(exec.mock.calls[0][1]).toEqual([
      "-c",
      expect.stringContaining("Path(memory_framework.__file__).resolve()"),
      f.core,
      f.shared,
    ]);
    expect(exec.mock.calls[0][1]?.[1]).toContain(
      "Path(memory_framework_shared.__file__).resolve()",
    );
    expect(installCalls()).toHaveLength(0);
    expect(existsSync(f.stamp)).toBe(false);
  });

  it("ignores an importable but stale non-editable checkout virtualenv", () => {
    const f = fixture();
    const localPython = pythonIn(join(f.source, ".venv"));
    write(localPython);
    exec.mockImplementation((command) => {
      if (command === localPython)
        throw new Error("source path assertion failed");
      return Buffer.alloc(0);
    });
    expect(resolvePythonRuntime(f.data, f.source)).toBe(f.python);
    expect(installCalls()).toHaveLength(1);
  });

  it("reinstalls source when switching from a bundled-wheel installation", () => {
    const f = fixture();
    const wheel = join(
      f.source,
      "python",
      "memory_framework_dsh-0.3.2-py3-none-any.whl",
    );
    write(wheel);
    resolvePythonRuntime(f.data, f.source);
    expect(installCalls()[0][1]).toEqual([
      "-m",
      "pip",
      "install",
      "--force-reinstall",
      "--no-deps",
      wheel,
    ]);
    rmSync(wheel);
    resolvePythonRuntime(f.data, f.source);
    expect(installCalls()[2][1]).toEqual(["-m", "pip", "install", f.source]);
    expect(readFileSync(f.stamp, "utf8")).toMatch(/^source-sha256:/);
  });
});

describe("bundled Python wheel upgrades", () => {
  function wheelFixture() {
    const f = fixture();
    const wheel = join(
      f.source,
      "python",
      "memory_framework_dsh-0.3.2-py3-none-any.whl",
    );
    write(wheel, "wheel revision one");
    return { ...f, wheel };
  }

  const forcedInstall = (wheel: string) => [
    "-m",
    "pip",
    "install",
    "--force-reinstall",
    "--no-deps",
    wheel,
  ];

  const wheelInstalls = () =>
    installCalls().filter(([, args]) => args?.includes("--force-reinstall"));

  it("migrates a filename-only stamp and reuses unchanged wheel bytes", () => {
    const f = wheelFixture();
    write(f.stamp, "memory_framework_dsh-0.3.2-py3-none-any.whl");
    expect(resolvePythonRuntime(f.data, f.source)).toBe(f.python);
    expect(wheelInstalls()).toHaveLength(1);
    expect(wheelInstalls()[0][1]).toEqual(forcedInstall(f.wheel));
    expect(installCalls()[1][1]).toEqual(["-m", "pip", "install", f.wheel]);
    expect(readFileSync(f.stamp, "utf8")).toMatch(
      /^wheel-sha256:[a-f0-9]{64}$/,
    );
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()).toHaveLength(1);
  });

  it("reinstalls replaced wheel bytes even when the filename and version stay the same", () => {
    const f = wheelFixture();
    resolvePythonRuntime(f.data, f.source);
    const previousStamp = readFileSync(f.stamp, "utf8");
    write(f.wheel, "wheel revision two");
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()).toHaveLength(2);
    expect(wheelInstalls()[1][1]).toEqual(forcedInstall(f.wheel));
    expect(readFileSync(f.stamp, "utf8")).not.toBe(previousStamp);
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()).toHaveLength(2);
  });

  it("does not advance the stamp after a failed replacement and retries", () => {
    const f = wheelFixture();
    resolvePythonRuntime(f.data, f.source);
    const previousStamp = readFileSync(f.stamp, "utf8");
    write(f.wheel, "wheel revision two");
    exec.mockImplementationOnce(() => {
      throw new Error("pip failed");
    });
    expect(() => resolvePythonRuntime(f.data, f.source)).toThrow("pip failed");
    expect(readFileSync(f.stamp, "utf8")).toBe(previousStamp);
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()).toHaveLength(3);
    expect(readFileSync(f.stamp, "utf8")).not.toBe(previousStamp);
  });

  it("keeps the previous stamp when dependency installation fails and retries both steps", () => {
    const f = wheelFixture();
    resolvePythonRuntime(f.data, f.source);
    const previousStamp = readFileSync(f.stamp, "utf8");
    write(f.wheel, "wheel revision two");
    exec.mockImplementationOnce(() => Buffer.alloc(0));
    exec.mockImplementationOnce(() => {
      throw new Error("dependency installation failed");
    });
    expect(() => resolvePythonRuntime(f.data, f.source)).toThrow(
      "dependency installation failed",
    );
    expect(readFileSync(f.stamp, "utf8")).toBe(previousStamp);
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()).toHaveLength(3);
    expect(installCalls()).toHaveLength(6);
    expect(readFileSync(f.stamp, "utf8")).not.toBe(previousStamp);
  });

  it("reinstalls a matching wheel when imports fail", () => {
    const f = wheelFixture();
    resolvePythonRuntime(f.data, f.source);
    exec.mockImplementationOnce(() => {
      throw new Error("missing module");
    });
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()).toHaveLength(2);
    expect(wheelInstalls()[1][1]).toEqual(forcedInstall(f.wheel));
  });

  it("forces installation when switching from a same-version source runtime", () => {
    const f = wheelFixture();
    rmSync(f.wheel);
    resolvePythonRuntime(f.data, f.source);
    expect(readFileSync(f.stamp, "utf8")).toMatch(/^source-sha256:/);
    write(f.wheel, "wheel revision one");
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()[0][1]).toEqual(forcedInstall(f.wheel));
    expect(installCalls()[2][1]).toEqual(["-m", "pip", "install", f.wheel]);
    expect(readFileSync(f.stamp, "utf8")).toMatch(/^wheel-sha256:/);
  });

  it("forces installation without a stamp even if a same-version package may exist", () => {
    const f = wheelFixture();
    expect(existsSync(f.stamp)).toBe(false);
    resolvePythonRuntime(f.data, f.source);
    expect(wheelInstalls()).toHaveLength(1);
    expect(wheelInstalls()[0][1]).toEqual(forcedInstall(f.wheel));
    expect(installCalls()[1][1]).toEqual(["-m", "pip", "install", f.wheel]);
    expect(readFileSync(f.stamp, "utf8")).toMatch(/^wheel-sha256:/);
  });
});
