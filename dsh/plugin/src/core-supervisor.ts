import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandPath } from "./transport.js";

export interface SupervisorOptions {
  coreUrl: string;
  credentialsFile: string;
  autoStartCore?: boolean;
  pythonCommand?: string;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
}

function parseLoopbackOrigin(url: string): { origin: string; port: number } {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("coreUrl must be a loopback HTTP origin");
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  return { origin: parsed.origin, port };
}

export async function isCoreHealthy(
  origin: string,
  timeoutMs = 1200,
): Promise<boolean> {
  try {
    const response = await fetch(origin + "/health", {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { status?: string };
    return data?.status === "ok";
  } catch {
    return false;
  }
}

function canImportMemoryFramework(
  pythonExe: string,
  sourceRoot?: string,
): boolean {
  try {
    execFileSync(
      pythonExe,
      [
        "-c",
        "import memory_framework, memory_framework_shared" +
          (sourceRoot
            ? "; import sys; from pathlib import Path; " +
              "raise SystemExit(0 if " +
              "Path(memory_framework.__file__).resolve() == Path(sys.argv[1]).resolve() and " +
              "Path(memory_framework_shared.__file__).resolve() == Path(sys.argv[2]).resolve() else 1)"
            : ""),
        ...(sourceRoot
          ? [
              join(
                sourceRoot,
                "dsh",
                "core",
                "memory_framework",
                "__init__.py",
              ),
              join(
                sourceRoot,
                "shared",
                "memory_framework_shared",
                "__init__.py",
              ),
            ]
          : []),
      ],
      {
        stdio: "ignore",
        timeout: 8000,
        windowsHide: true,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function findSystemPython(preferred?: string): {
  command: string;
  prefixArgs: string[];
} {
  const candidates: Array<{ command: string; prefixArgs: string[] }> = [];
  if (preferred?.trim()) {
    candidates.push({ command: preferred.trim(), prefixArgs: [] });
  }
  if (process.env.MEMORY_FRAMEWORK_PYTHON?.trim()) {
    candidates.push({
      command: process.env.MEMORY_FRAMEWORK_PYTHON.trim(),
      prefixArgs: [],
    });
  }
  if (process.platform === "win32") {
    candidates.push(
      { command: "python", prefixArgs: [] },
      { command: "py", prefixArgs: ["-3"] },
      { command: "python3", prefixArgs: [] },
    );
  } else {
    candidates.push(
      { command: "python3", prefixArgs: [] },
      { command: "python", prefixArgs: [] },
    );
  }
  for (const candidate of candidates) {
    try {
      execFileSync(
        candidate.command,
        [
          ...candidate.prefixArgs,
          "-c",
          "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)",
        ],
        { stdio: "ignore", timeout: 8000, windowsHide: true },
      );
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  throw new Error(
    "未找到 Python >= 3.12 运行环境，请安装 Python 3.12+ 或在插件配置中指定 pythonCommand。",
  );
}

function resolveRepoRoot(pluginRoot: string): string {
  if (existsSync(join(pluginRoot, "pyproject.toml"))) {
    return pluginRoot;
  }
  return resolve(pluginRoot, "..", "..");
}

function resolveDashboardDir(pluginRoot: string, repoRoot: string): string {
  for (const candidate of [
    join(pluginRoot, "dashboard"),
    join(pluginRoot, "dsh", "plugin", "dashboard"),
    join(repoRoot, "dsh", "plugin", "dashboard"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(pluginRoot, "dashboard");
}

function findBundledWheel(pluginRoot: string, repoRoot: string): string | null {
  for (const dir of [
    join(pluginRoot, "python"),
    join(pluginRoot, "dsh", "plugin", "python"),
    join(repoRoot, "dsh", "plugin", "python"),
    join(repoRoot, "dist", "dsh"),
    join(repoRoot, "dist"),
  ]) {
    if (!existsSync(dir)) continue;
    const wheel = readdirSync(dir)
      .filter(
        (name) =>
          name.startsWith("memory_framework_dsh-") && name.endsWith(".whl"),
      )
      .sort()
      .at(-1);
    if (wheel) return join(dir, wheel);
  }
  return null;
}

function sourceStamp(repoRoot: string): string {
  const hash = createHash("sha256");
  const addFile = (path: string) => {
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(join(repoRoot, path)))
      .update("\0");
  };
  const addDirectory = (path: string) => {
    for (const entry of readdirSync(join(repoRoot, path), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__pycache__") continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) addDirectory(child);
      else if (entry.isFile() && entry.name.endsWith(".py")) addFile(child);
    }
  };
  addFile("pyproject.toml");
  addDirectory(join("dsh", "core", "memory_framework"));
  addDirectory(join("shared", "memory_framework_shared"));
  return `source-sha256:${hash.digest("hex")}`;
}

export function resolvePythonRuntime(
  dataDir: string,
  pluginRoot: string,
  pythonCommand?: string,
): string {
  const isWin = process.platform === "win32";
  const venvBin = (root: string) =>
    isWin
      ? join(root, "Scripts", "python.exe")
      : join(root, "bin", "python");

  const repoRoot = resolveRepoRoot(pluginRoot);
  // Reuse editable checkout environments, not stale copies in site-packages.
  if (existsSync(join(repoRoot, "pyproject.toml"))) {
    for (const candidateRoot of [
      join(repoRoot, ".venv"),
      join(repoRoot, "dsh", ".venv"),
    ]) {
      const exe = venvBin(candidateRoot);
      if (existsSync(exe) && canImportMemoryFramework(exe, repoRoot)) {
        return exe;
      }
    }
  }

  const runtimeDir = join(dataDir, "runtime");
  const runtimePython = venvBin(runtimeDir);
  if (!existsSync(runtimePython)) {
    mkdirSync(dataDir, { recursive: true });
    const sysPython = findSystemPython(pythonCommand);
    execFileSync(
      sysPython.command,
      [...sysPython.prefixArgs, "-m", "venv", runtimeDir],
      { stdio: "ignore", timeout: 120000, windowsHide: true },
    );
  }

  const wheelPath = findBundledWheel(pluginRoot, repoRoot);
  const stampFile = join(runtimeDir, ".wheel-stamp");
  const currentStamp = existsSync(stampFile)
    ? readFileSync(stampFile, "utf8").trim()
    : "";

  if (wheelPath) {
    // A rebuilt wheel can keep its filename and version while its bytes change.
    const stamp = `wheel-sha256:${createHash("sha256")
      .update(readFileSync(wheelPath))
      .digest("hex")}`;
    if (currentStamp !== stamp || !canImportMemoryFramework(runtimePython)) {
      execFileSync(
        runtimePython,
        ["-m", "pip", "install", "--force-reinstall", "--no-deps", wheelPath],
        {
          stdio: "ignore",
          timeout: 300000,
          windowsHide: true,
        },
      );
      // Resolve the installed wheel's dependencies without forcing their upgrade.
      execFileSync(runtimePython, ["-m", "pip", "install", wheelPath], {
        stdio: "ignore",
        timeout: 300000,
        windowsHide: true,
      });
      writeFileSync(stampFile, stamp, "utf8");
    }
    return runtimePython;
  }

  if (existsSync(join(repoRoot, "pyproject.toml"))) {
    const stamp = sourceStamp(repoRoot);
    if (currentStamp !== stamp || !canImportMemoryFramework(runtimePython)) {
      execFileSync(runtimePython, ["-m", "pip", "install", repoRoot], {
        stdio: "ignore",
        timeout: 300000,
        windowsHide: true,
      });
      writeFileSync(stampFile, stamp, "utf8");
    }
    return runtimePython;
  }

  if (canImportMemoryFramework(runtimePython)) {
    return runtimePython;
  }

  throw new Error(
    "未找到内置的 memory_framework_dsh Python 组件包，请重新安装完整插件包。",
  );
}

export async function ensureCoreDaemon(
  options: SupervisorOptions,
): Promise<() => void> {
  const { origin, port } = parseLoopbackOrigin(options.coreUrl);
  const credentialsPath = expandPath(options.credentialsFile);
  const dataDir = dirname(credentialsPath);

  if (existsSync(credentialsPath) && (await isCoreHealthy(origin))) {
    return () => {};
  }

  if (options.autoStartCore === false) {
    return () => {};
  }

  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pythonExe = resolvePythonRuntime(
    dataDir,
    pluginRoot,
    options.pythonCommand,
  );

  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(credentialsPath)) {
    execFileSync(
      pythonExe,
      ["-m", "memory_framework", "init", "--data-dir", dataDir],
      {
        stdio: "ignore",
        timeout: 30000,
        windowsHide: true,
      },
    );
  }

  if (await isCoreHealthy(origin)) {
    return () => {};
  }

  const repoRoot = resolveRepoRoot(pluginRoot);
  const uiDir = resolveDashboardDir(pluginRoot, repoRoot);
  const serveArgs = [
    "-m",
    "memory_framework",
    "serve",
    "--data-dir",
    dataDir,
    "--port",
    String(port),
  ];
  if (existsSync(uiDir)) {
    serveArgs.push("--ui-dir", uiDir);
  }

  let child: ChildProcess | undefined = spawn(pythonExe, serveArgs, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrTail.length < 4096) {
      stderrTail += chunk.toString("utf8");
    }
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isCoreHealthy(origin, 1000)) {
      options.logger?.info?.(
        `Memory Framework core daemon ready at ${origin}`,
      );
      return () => {
        if (child && !exited) {
          child.kill();
          child = undefined;
        }
      };
    }
    if (
      exited &&
      !stderrTail.includes("already has a running memory daemon")
    ) {
      break;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 150));
  }

  if (await isCoreHealthy(origin, 1500)) {
    return () => {};
  }

  throw new Error(
    `无法自动启动 Memory Framework 本地核心 (${origin})${stderrTail ? `: ${stderrTail.trim()}` : ""}`,
  );
}
