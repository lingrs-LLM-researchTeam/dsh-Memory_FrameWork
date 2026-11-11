"""Restrict locally stored credentials before writing their secret values."""

import csv
import io
import os
import re
import subprocess


def secure_file(path):
    if os.name != "nt":
        os.chmod(path, 0o600)
        return
    identity = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"],
        capture_output=True,
        text=True,
        check=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    sid = next(csv.reader(io.StringIO(identity.stdout)))[1]
    if not re.fullmatch(r"S-1-(?:\d+-)*\d+", sid):
        raise RuntimeError("Cannot identify the Windows credential owner")
    subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid}:F", "*S-1-5-18:F"],
        capture_output=True,
        check=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
