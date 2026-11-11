---
name: dsh-memory-workflow
description: Operational guide and token-efficient workflows for the DeepSeek Harness (DSH) Memory Framework plugin. Use when managing cross-window long-horizon tasks, proposing source-grounded memories with verbatim quotes, paginating large source evidence, or handling revision_conflict, verification_required, evidence_budget_exhausted, and clean_handoff_required states.
---

# DSH Memory Framework Workflow Skill

Use this skill to operate the `dsh-memory-framework` tools (`memory_search`, `memory_read`, `memory_remember`, `memory_task_state`, `memory_task_update`, `memory_checkpoint`) accurately while minimizing token overhead and preserving per-turn evidence budgets.

## 1. Zero-Redundancy Context Rule (Save Per-Turn Quota)

Before calling any `memory_*` tool, inspect the `<memory-framework-context>` block already injected in the current turn:
- **Do not call `memory_task_state`** if the injected `Task:` section already shows the current `id`, `revision`, `goal`, `constraints`, `acceptance`, and `next_action`, unless a `revision_conflict` occurred during this turn.
- **Do not call `memory_search`** for facts already present in the injected `Memories:` section unless you need additional `source_ids` or deeper context not shown in the summary.
- Every tool call—**including failed attempts**—consumes the per-turn quota (default: `12` tool calls, `3` writes, and the workspace's `evidence_bytes` budget).

## 2. Proposing Grounded Memories (`memory_remember`)

`memory_remember` enforces strict source attribution in the backend (`memory.propose`). Ungrounded claims or paraphrased quotes are rejected.

### Workflow
1. **Locate the source**: Call `memory_search(query="...")` to find relevant memory IDs, or call `memory_read(id=<memory_id>)` to inspect the attached `sources` array (`id`, `content`, `revision`, `truncated`, `next_offset`).
2. **Paginate only when needed**: If `truncated: true` and the required quote is beyond the first page (`2,000` chars by default), call `memory_read(id=<memory_id>, source_id="<source_id>", offset=<next_offset>)`.
3. **Propose with exact quotes**:
   - `source_ids` must be non-empty and contain valid `source.id` strings accessible to the current session.
   - When passing `claims_json`, every `evidence[].quote` **must be an exact, character-for-character substring** of the corresponding `source_uid`'s original text:

```json
[
  {
    "assertion": "Database migrations must remain backward-compatible with schema v2",
    "subject_id": "workspace:db-schema",
    "predicate": "requires_constraint",
    "value": "backward-compatible with schema v2",
    "qualifier": "mandatory",
    "evidence": [
      {
        "source_uid": "local:s1:14",
        "quote": "backward-compatible with schema v2"
      }
    ]
  }
]
```

## 3. Cross-Window Task State Machine & CAS Updates

Tasks persist across DSH windows and use optimistic concurrency control (`expected_revision`).

### Updating Progress (`memory_task_update`)
- **Batch your writes**: Because each turn allows at most `3` write operations by default, combine `status`, `next_action`, `blockers`, and `evidence_ids` into a **single** `memory_task_update` call at the end of a milestone rather than updating after every micro-step.
- **Handling `revision_conflict`**: If another window updated the task concurrently, call `memory_task_state` once to read the new `revision` and latest fields, merge your progress, and submit a single retry with the updated `expected_revision`.
- **Handling `verification_required` (Completion Gate)**:
  - The model **cannot** set `status: "completed"` while any item in `acceptance` is unverified (`verification[criterion]` is empty).
  - Human verification (`task.verify`) is an owner-only Dashboard action.
  - When all implementation work is done and ready for acceptance:
    1. Call `memory_task_update` with `status: "verifying"`, `next_action: "等待在 Memory Dashboard 完成人工验收"`, and `evidence_ids` pointing to the supporting source IDs.
    2. Call `memory_checkpoint` with the returned `revision` to save a clean handoff snapshot.
    3. Instruct the user to verify the acceptance criteria in the right-hand **Memory Framework · 记忆与任务 → 任务与工作区** panel.

## 4. Boundary Between Model Tools and Owner Dashboard

Never attempt to simulate or retry operations that are restricted to the `admin` channel. Guide the user to the Dashboard instead:

| Operation | Channel | How to Handle When Needed |
|---|---|---|
| Create task / edit `goal`, `constraints`, `acceptance` | Owner Dashboard (`02 任务与工作区`) | Ask the user to create or edit the task in the Dashboard and bind it to the current session. |
| Verify acceptance criteria (`task.verify`) | Owner Dashboard (`02 任务与工作区`) | Set task `status: "verifying"` with `evidence_ids`, then ask the user to fill in the acceptance note in the Dashboard. |
| Change memory sharing scope (`session`/`task`/`workspace`/`global`) | Owner Dashboard (`01 记忆库` / `03 广播范围`) | `memory_remember` always creates session-private memories; ask the user to widen scope in the Dashboard if cross-workspace sharing is desired. |
| Revoke polluted source (`source.revoke`) & Clean Handoff (`clean_handoff_required`) | Owner Dashboard (`01 记忆库` / 顶部警告栏) | If a session is fenced due to revoked evidence, instruct the user to click **「创建干净接续会话」** in the Memory Dashboard. |
| Adjust per-turn byte/call budgets or promote tool evidence | Owner Dashboard (`06 预算与收录`) | If `evidence_budget_exhausted` blocks required deep reading, either wait for the next user turn (`turn/start` resets per-turn counters) or ask the user to raise the workspace quota. |
