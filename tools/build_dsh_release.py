"""Build the DSH plugin, Python wheel and a source-inclusive distribution."""

from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "dsh" / "plugin"
DIST = ROOT / "dist" / "dsh"
VERSION = "0.3.2"


def main():
    DIST.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "LICENSE", PLUGIN / "LICENSE")
    (PLUGIN / "lib" / "index.mjs").unlink(missing_ok=True)
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise SystemExit("npm is required")
    subprocess.run([npm, "run", "build"], cwd=PLUGIN, check=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--wheel",
            "--no-isolation",
            "--outdir",
            str(DIST),
        ],
        cwd=ROOT,
        check=True,
    )
    wheel = DIST / f"memory_framework_dsh-{VERSION}-py3-none-any.whl"
    bundled_python = PLUGIN / "python"
    if bundled_python.exists():
        shutil.rmtree(bundled_python)
    bundled_python.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(wheel, bundled_python / wheel.name)
    subprocess.run(
        [npm, "pack", "--ignore-scripts", "--pack-destination", str(DIST)],
        cwd=PLUGIN,
        check=True,
    )
    package = DIST / f"dsh-memory-framework-{VERSION}.tgz"
    bundle = DIST / f"memory-framework-dsh-{VERSION}.zip"
    entries = [
        (wheel, wheel.name),
        (package, package.name),
        (ROOT / "LICENSE", "LICENSE"),
        (ROOT / "dsh/README.md", "README.md"),
        (ROOT / "dsh/README.md", "dsh/README.md"),
        (ROOT / "dsh/start.ps1", "start.ps1"),
    ]
    report = ROOT / "docs/DSH开发技术报告.md"
    if report.exists():
        entries.append((report, "docs/DSH开发技术报告.md"))
    for path in (ROOT / "docs/research").glob("*.md"):
        entries.append((path, "docs/research/" + path.name))
    for folder in ("images", "validation"):
        for path in (ROOT / "docs" / folder).glob("dsh-*"):
            if path.is_file():
                entries.append((path, "docs/" + folder + "/" + path.name))
    for path in (PLUGIN / "dashboard").rglob("*"):
        if path.is_file():
            entries.append(
                (path, "dashboard/" + path.relative_to(PLUGIN / "dashboard").as_posix())
            )
    # The GPL distribution includes matching source and the reproducible lockfile.
    for base in (
        ROOT / "dsh",
        ROOT / "shared/memory_framework_shared",
    ):
        for path in base.rglob("*"):
            if not path.is_file() or set(path.relative_to(base).parts) & {
                "node_modules",
                "lib",
                "dashboard",
                "python",
                ".compiled",
                "__pycache__",
                ".pytest_cache",
                "data",
                "plugin_data",
            }:
                continue
            if (
                path.name.startswith(".env")
                or path.name == "credentials.json"
                or path.suffix in {".db", ".sqlite", ".sqlite3", ".log", ".pyc"}
            ):
                continue
            entries.append((path, "source/" + path.relative_to(ROOT).as_posix()))
    for path in (
        ROOT / "pyproject.toml",
        ROOT / "README.md",
        ROOT / "LICENSE",
        ROOT / "tools/build_dsh_release.py",
        ROOT / "tools/seed_dsh_demo.py",
        ROOT / "tools/check_distribution.py",
    ):
        entries.append((path, "source/" + path.relative_to(ROOT).as_posix()))
    sources = {
        name.removeprefix("source/"): hashlib.sha256(path.read_bytes()).hexdigest()
        for path, name in entries
        if name.startswith("source/")
    }
    source_manifest = ROOT / "source-manifest.json"
    source_manifest.write_text(
        json.dumps(
            {
                "release": VERSION,
                "scope": "DSH",
                "files": [
                    {"path": name, "sha256": digest}
                    for name, digest in sorted(sources.items())
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    entries.append((source_manifest, "source/source-manifest.json"))
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, name in entries:
            archive.write(path, name)
    files = [wheel, package, bundle]
    manifest = {
        "version": VERSION,
        "dsh": "0.2.2-rc.1",
        "files": [
            {
                "name": p.name,
                "bytes": p.stat().st_size,
                "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            }
            for p in files
        ],
    }
    (DIST / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
