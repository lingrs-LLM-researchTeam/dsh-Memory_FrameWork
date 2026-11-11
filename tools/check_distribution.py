"""Ensure DSH builds without AstrBot and includes its shared algorithms."""

from pathlib import Path
import ast
import zipfile

root = Path(__file__).resolve().parents[1]
assert not (root / "plugins").exists(), "AstrBot runtime belongs in its own repository"
for base in (root / "dsh/core", root / "shared"):
    for path in base.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = (
                [a.name for a in node.names]
                if isinstance(node, ast.Import)
                else [node.module or ""]
                if isinstance(node, ast.ImportFrom)
                else []
            )
            assert not any(
                name.startswith(("astrbot", "plugins.")) for name in names
            ), path
for directory in (root / "dist", root / "dist/dsh"):
    for wheel in directory.glob("memory_framework_dsh-*.whl"):
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
            assert any(n.startswith("memory_framework_shared/") for n in names)
            assert not any("astrbot_plugin" in n or "/learning/" in n for n in names)
print("DSH source and wheel separation verified")
