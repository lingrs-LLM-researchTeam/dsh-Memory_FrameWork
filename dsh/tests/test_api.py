from fastapi.testclient import TestClient
from memory_framework.api import create_app
from memory_framework.engine import Engine


def test_channel_auth_csrf_and_cookie(tmp_path):
    engine = Engine(tmp_path / "api.db")
    host = "h" * 40
    admin = "a" * 40
    with TestClient(create_app(engine, host, admin)) as client:
        command = {"operation": "snapshot"}
        assert client.post("/v1/admin", json=command).status_code == 401
        assert (
            client.post(
                "/v1/admin", json=command, headers={"Authorization": f"Bearer {host}"}
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/v1/model", json=command, headers={"Authorization": f"Bearer {host}"}
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/dashboard/login",
                json={"token": admin},
                headers={"Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        login = client.post("/dashboard/login", json={"token": admin})
        assert login.status_code == 200
        assert "HttpOnly" in login.headers["set-cookie"]
        assert client.post("/v1/admin", json=command).status_code == 200
        assert (
            client.post(
                "/v1/admin", json=command, headers={"Origin": "https://evil.example"}
            ).status_code
            == 403
        )
        client.post("/dashboard/logout")
        assert client.post("/v1/admin", json=command).status_code == 401
    engine.close()


def test_credentials_and_payload_validation(tmp_path):
    import pytest

    engine = Engine(tmp_path / "api.db")
    with pytest.raises(ValueError):
        create_app(engine, "same" * 10, "same" * 10)
    with TestClient(create_app(engine, "h" * 40, "a" * 40)) as client:
        assert (
            client.post(
                "/v1/host",
                headers={"Authorization": "Bearer " + "h" * 40},
                json={
                    "operation": "workspace.upsert",
                    "payload": {
                        "id": "w",
                        "name": "W",
                        "path": "/w",
                        "instance_id": "x",
                        "extra": "no",
                    },
                },
            ).status_code
            == 422
        )
    engine.close()


def test_daemon_directory_lock_rejects_second_writer_and_releases(tmp_path):
    import pytest
    from memory_framework.__main__ import ProcessLock

    first = ProcessLock(tmp_path / "daemon.lock")
    try:
        with pytest.raises(SystemExit, match="already has a running"):
            ProcessLock(tmp_path / "daemon.lock")
    finally:
        first.close()
    second = ProcessLock(tmp_path / "daemon.lock")
    second.close()
