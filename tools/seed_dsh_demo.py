"""Create explicit, disposable Dashboard evaluation fixtures; never uses the default data root."""

import argparse
import json
from pathlib import Path

from memory_framework.engine import Engine


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    database = args.data_dir / "memory.sqlite3"
    if database.exists():
        raise SystemExit("Refusing to overwrite an existing fixture database")
    engine = Engine(database)
    try:
        for identity, title, path in (
            ("demo:memory", "Memory Framework", "E:/projects/memory"),
            ("demo:research", "研究工作区", "E:/projects/research"),
        ):
            engine.execute(
                "workspace.upsert",
                {"id": identity, "name": title, "path": path, "instance_id": "demo"},
                channel="host",
            )
        for sid, wid in (
            ("demo:design", "demo:memory"),
            ("demo:implementation", "demo:memory"),
            ("demo:analysis", "demo:research"),
        ):
            engine.execute(
                "session.upsert", {"id": sid, "workspace_id": wid}, channel="host"
            )
        task = engine.execute(
            "task.create",
            {
                "workspace_id": "demo:memory",
                "title": "DSH 长程任务记忆适配",
                "goal": "完成跨窗口记忆与任务状态同步，提供可解释的记忆管理面板。",
                "constraints": [
                    "共享范围不能越过工作区授权",
                    "每条事实必须保留可核验来源",
                ],
                "acceptance": [
                    "两个窗口读取同一任务进度",
                    "撤销来源后不再召回派生记忆",
                ],
            },
            channel="admin",
        )
        for sid in ("demo:design", "demo:implementation"):
            engine.execute(
                "session.bind",
                {"session_id": sid, "task_id": task["id"], "expected_task_id": None},
                channel="admin",
            )
        engine.execute(
            "task.update",
            {
                "id": task["id"],
                "expected_revision": 1,
                "status": "active",
                "next_action": "验证广播范围变更与断线重连",
                "decisions": ["任务账本使用 SQLite 事务与版本检查"],
            },
            "demo:design",
            "admin",
        )
        fixtures = [
            (
                "决定使用 SQLite WAL 保存权威任务状态。向量索引作为可重建的派生数据。",
                "decision",
                0.92,
                "task",
                True,
            ),
            (
                "工作区的读取权限优先于记忆排序权重；订阅更新不会自动授予读取权限。",
                "constraint",
                0.95,
                "workspace",
                True,
            ),
            (
                "当前会话负责接口设计，实施会话负责集成验证。两者关联同一任务。",
                "note",
                0.65,
                "task",
                False,
            ),
            (
                "用户偏好：技术报告使用中文，区分已验证的结果和待验证的推断。",
                "preference",
                0.75,
                "global",
                False,
            ),
        ]
        for content, kind, importance, scope, pinned in fixtures:
            engine.execute(
                "memory.create",
                {
                    "content": content,
                    "kind": kind,
                    "importance": importance,
                    "scope": scope,
                    "pinned": pinned,
                },
                "demo:design",
                "admin",
            )
        engine.execute(
            "memory.create",
            {
                "content": "研究工作区的私有资料，只在本工作区内使用。",
                "scope": "workspace",
                "importance": 0.8,
            },
            "demo:analysis",
            "admin",
        )
        print(
            json.dumps(
                {
                    "workspace": "demo:memory",
                    "session": "demo:design",
                    "task_id": task["id"],
                }
            )
        )
    finally:
        engine.close()


if __name__ == "__main__":
    main()
