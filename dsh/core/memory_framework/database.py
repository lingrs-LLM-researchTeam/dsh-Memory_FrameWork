"""SQLite is authority; all commands commit their event in the same transaction."""

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta VALUES('schema',1),('policy',1);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,instance_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),task_id TEXT,subscribed INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT -1);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),workspace_id TEXT NOT NULL,task_id TEXT,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,metadata TEXT NOT NULL,created_at REAL NOT NULL,UNIQUE(session_id,event_id));
CREATE TABLE IF NOT EXISTS source_history(source_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(source_id,revision));
CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,workspace_id TEXT NOT NULL,task_id TEXT,content TEXT NOT NULL,kind TEXT NOT NULL,importance REAL NOT NULL,pinned INTEGER NOT NULL,scope TEXT NOT NULL,targets TEXT NOT NULL,broadcast INTEGER NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL,claims TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, memory_id UNINDEXED,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS memory_sources(memory_id INTEGER NOT NULL REFERENCES memories(id),source_id TEXT NOT NULL REFERENCES sources(id),revision INTEGER NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(memory_id,source_id));
CREATE TABLE IF NOT EXISTS memory_history(memory_id INTEGER NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(memory_id,revision));
CREATE TABLE IF NOT EXISTS memory_claims(memory_id INTEGER NOT NULL REFERENCES memories(id),claim_id TEXT NOT NULL,subject TEXT NOT NULL,predicate TEXT NOT NULL,value TEXT NOT NULL,valid_from REAL,valid_to REAL,PRIMARY KEY(memory_id,claim_id));
CREATE INDEX IF NOT EXISTS idx_claim_relation ON memory_claims(subject,predicate);
CREATE TABLE IF NOT EXISTS embeddings(memory_id INTEGER PRIMARY KEY REFERENCES memories(id),revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,vector TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision INTEGER NOT NULL,state TEXT NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),revision INTEGER NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created_at REAL NOT NULL,UNIQUE(task_id,revision));
CREATE TABLE IF NOT EXISTS profiles(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),revision INTEGER NOT NULL,weights TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_history(workspace_id TEXT NOT NULL,revision INTEGER NOT NULL,weights TEXT NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(workspace_id,revision));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,revision INTEGER NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT,task_id TEXT,broadcast INTEGER NOT NULL,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS injections(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,policy INTEGER NOT NULL,task_id TEXT,task_revision INTEGER,memories TEXT NOT NULL,sources TEXT NOT NULL,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pending_inputs(session_id TEXT NOT NULL,message_id TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(session_id,message_id));
CREATE TABLE IF NOT EXISTS tool_calls(session_id TEXT NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(session_id,call_id));
CREATE TABLE IF NOT EXISTS inherited_receipts(session_id TEXT NOT NULL,receipt_id INTEGER NOT NULL,PRIMARY KEY(session_id,receipt_id));
CREATE TABLE IF NOT EXISTS session_fences(session_id TEXT PRIMARY KEY,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applied_corrections(session_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(session_id,event_id));
CREATE TABLE IF NOT EXISTS goal_projections(session_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,task_id TEXT NOT NULL,objective TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memories(workspace_id,status);
CREATE INDEX IF NOT EXISTS idx_source_session ON sources(session_id,sequence);
CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace_id,id);
CREATE TABLE IF NOT EXISTS workspace_policies(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),revision INTEGER NOT NULL,settings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence_usage(session_id TEXT PRIMARY KEY,turn_sequence INTEGER NOT NULL DEFAULT -1,used_bytes INTEGER NOT NULL DEFAULT 0,tool_calls INTEGER NOT NULL DEFAULT 0,writes INTEGER NOT NULL DEFAULT 0,context_signature TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS context_snapshots(session_id TEXT PRIMARY KEY,signature TEXT NOT NULL,text TEXT NOT NULL,receipt_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session_context(session_id TEXT PRIMARY KEY REFERENCES sessions(id),settings TEXT NOT NULL,observed_at REAL NOT NULL);
INSERT OR IGNORE INTO meta VALUES('context_advice_ack',0);
CREATE TABLE IF NOT EXISTS embedding_dimensions(config_key TEXT PRIMARY KEY,dimensions INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS embedding_usage(workspace_id TEXT NOT NULL,day TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,input_chars INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace_id,day));
CREATE TABLE IF NOT EXISTS embedding_failures(memory_id INTEGER PRIMARY KEY,attempts INTEGER NOT NULL,retry_at REAL NOT NULL);
INSERT OR IGNORE INTO meta VALUES('vectors',0);
CREATE TRIGGER IF NOT EXISTS embedding_added AFTER INSERT ON embeddings BEGIN UPDATE meta SET value=value+1 WHERE key='vectors'; END;
CREATE TRIGGER IF NOT EXISTS embedding_removed AFTER DELETE ON embeddings BEGIN UPDATE meta SET value=value+1 WHERE key='vectors'; END;
CREATE TRIGGER IF NOT EXISTS embedding_changed AFTER UPDATE OF vector,fingerprint ON embeddings BEGIN UPDATE meta SET value=value+1 WHERE key='vectors'; END;
"""


def dump(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


class Database:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(
            str(path), isolation_level=None, check_same_thread=False
        )
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA busy_timeout=10000")
        if self.connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name='meta'"
        ).fetchone():
            version = self.connection.execute(
                "SELECT value FROM meta WHERE key='schema'"
            ).fetchone()
            if version and version[0] not in (1, 2, 3):
                self.connection.close()
                raise RuntimeError(
                    "Unsupported database schema; refusing to overwrite data"
                )
        self.connection.executescript(SCHEMA)
        version = self.connection.execute(
            "SELECT value FROM meta WHERE key='schema'"
        ).fetchone()[0]
        if version not in (1, 2, 3):
            raise RuntimeError(
                "Unsupported database schema; refusing to overwrite data"
            )
        if version == 1:
            with self.transaction() as db:
                db.execute(
                    "ALTER TABLE memories ADD COLUMN vector_enabled INTEGER NOT NULL DEFAULT 1"
                )
                db.execute("UPDATE meta SET value=2 WHERE key='schema'")
        self.connection.execute("UPDATE meta SET value=3 WHERE key='schema'")

    @contextmanager
    def transaction(self):
        with self.lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield self.connection
                self.connection.commit()
            except BaseException:
                self.connection.rollback()
                raise

    def close(self):
        self.connection.close()
