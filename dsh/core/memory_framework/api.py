"""Loopback HTTP transport. Host, model and human administration are separate channels."""

import asyncio
import contextlib
import hashlib
import hmac
import logging
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .engine import Engine, DomainError
from .models import Dispatch
from . import __version__


def create_app(
    engine: Engine, host_token: str, admin_token: str, ui_dir: Path | None = None
):
    if min(len(host_token), len(admin_token)) < 32 or host_token == admin_token:
        raise ValueError(
            "Distinct host/admin tokens of at least 32 characters are required"
        )
    login_attempts = {}
    cookie_key = secrets.token_bytes(32)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        async def worker():
            while True:
                try:
                    await asyncio.to_thread(engine.index_pending)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logging.getLogger(__name__).warning(
                        "Embedding worker unavailable; lexical retrieval remains available"
                    )
                await asyncio.sleep(10)

        task = asyncio.create_task(worker())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    app = FastAPI(title="Memory Framework", version=__version__, lifespan=lifespan)

    def origin_guard(request):
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "Cross-origin request rejected")

    def cookie_valid(value):
        try:
            expires, signature = value.split(".", 1)
            return int(expires) > time.time() and hmac.compare_digest(
                signature,
                hmac.new(cookie_key, expires.encode(), hashlib.sha256).hexdigest(),
            )
        except (ValueError, AttributeError):
            return False

    def authorize(request, channel):
        origin_guard(request)
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
        expected = admin_token if channel == "admin" else host_token
        if channel == "admin" and cookie_valid(request.cookies.get("memory_dashboard")):
            return
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(401, "Authentication required")

    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        return JSONResponse(
            status_code=exc.status,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )

    @app.exception_handler(ValidationError)
    async def validation_error(request, exc):
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": str(exc)}},
        )

    @app.get("/health")
    def health():
        return {"status": "ok", "version": __version__}

    @app.post("/dashboard/login")
    async def login(request: Request):
        origin_guard(request)
        peer = request.client.host if request.client else "unknown"
        now = time.monotonic()
        attempts = [t for t in login_attempts.get(peer, []) if now - t < 60]
        if len(attempts) >= 10:
            raise HTTPException(429, "Too many login attempts")
        login_attempts[peer] = [*attempts, now]
        body = await request.json()
        if not isinstance(body, dict) or not hmac.compare_digest(
            str(body.get("token", "")), admin_token
        ):
            raise HTTPException(401, "Invalid token")
        expires = str(int(time.time()) + 8 * 3600)
        value = (
            expires
            + "."
            + hmac.new(cookie_key, expires.encode(), hashlib.sha256).hexdigest()
        )
        response = JSONResponse({"ok": True})
        response.set_cookie(
            "memory_dashboard",
            value,
            httponly=True,
            samesite="strict",
            max_age=8 * 3600,
            secure=request.url.scheme == "https",
        )
        return response

    @app.post("/dashboard/logout")
    def logout(request: Request):
        origin_guard(request)
        response = JSONResponse({"ok": True})
        response.delete_cookie("memory_dashboard")
        return response

    @app.get("/dashboard/session")
    def dashboard_session(request: Request):
        return {"authenticated": cookie_valid(request.cookies.get("memory_dashboard"))}

    @app.post("/v1/{channel}")
    def dispatch(channel: str, command: Dispatch, request: Request):
        if channel not in ("admin", "host", "model"):
            raise HTTPException(404)
        authorize(request, channel)
        try:
            return engine.execute(
                command.operation, command.payload, command.session_id, channel
            )
        except (KeyError, TypeError, ValueError) as exc:
            if isinstance(exc, ValidationError):
                raise
            raise HTTPException(422, "Invalid operation payload") from exc

    if ui_dir and (ui_dir / "index.html").is_file():
        app.mount("/assets", StaticFiles(directory=ui_dir / "assets"), name="assets")

        @app.get("/")
        def dashboard():
            return FileResponse(ui_dir / "index.html")

    return app
