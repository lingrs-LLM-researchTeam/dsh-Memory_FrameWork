"""CLI for the local, single-writer memory daemon."""

import argparse
import json
import os
import secrets
from pathlib import Path


class ProcessLock:
    def __init__(self, path):
        self.file = open(path, "a+b")
        # Reading byte zero would itself fail while a Windows range lock is held.
        # Inspect the length without reading the locked region, then acquire the lock.
        self.file.seek(0, os.SEEK_END)
        if self.file.tell() == 0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise SystemExit("This data directory already has a running memory daemon")

    def close(self):
        self.file.close()


def main():
    parser = argparse.ArgumentParser(description="Memory Framework DSH runtime")
    parser.add_argument("command", choices=["init", "serve", "index"])
    parser.add_argument(
        "--data-dir", type=Path, default=Path.home() / ".memory-framework"
    )
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--ui-dir", type=Path)
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    secrets_path = args.data_dir / "credentials.json"
    if args.command == "init":
        if secrets_path.exists():
            raise SystemExit("Credentials already exist; refusing to replace them")
        with secrets_path.open("x", encoding="utf-8") as output:
            from .permissions import secure_file

            try:
                secure_file(secrets_path)
            except Exception:
                output.close()
                secrets_path.unlink(missing_ok=True)
                raise
            json.dump(
                {
                    "host_token": secrets.token_urlsafe(48),
                    "admin_token": secrets.token_urlsafe(48),
                },
                output,
                indent=2,
            )
        print(
            f"Initialized {args.data_dir}. Configure the DSH credentialsFile with {secrets_path}. Keep this file private."
        )
        return
    if not secrets_path.exists():
        raise SystemExit("Run memory-framework init first")
    from .permissions import secure_file

    secure_file(secrets_path)
    credentials = json.loads(secrets_path.read_text(encoding="utf-8"))
    lock = ProcessLock(args.data_dir / "daemon.lock")
    from .engine import Engine

    engine = Engine(args.data_dir / "memory.sqlite3")
    try:
        if args.command == "index":
            print(engine.index_pending(limit=10000))
            return
        import uvicorn
        from .api import create_app

        uvicorn.run(
            create_app(
                engine,
                credentials["host_token"],
                credentials["admin_token"],
                args.ui_dir,
            ),
            host="127.0.0.1",
            port=args.port,
            access_log=False,
        )
    finally:
        engine.close()
        lock.close()


if __name__ == "__main__":
    main()
