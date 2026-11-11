"""Wire-sized evidence budgeting and exact source pagination, independent of host UI."""

import json


def wire_bytes(value):
    # The host JSON.stringify is compact; a spaced representation is a conservative ceiling.
    return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def text_bytes(value):
    return len(value.encode("utf-8"))


def excerpt(text, chars):
    return text[:chars]


def memory_view(memory, chars):
    fields = (
        "id",
        "revision",
        "content",
        "kind",
        "scope",
        "importance",
        "source_ids",
        "epistemic_status",
        "evidence_current",
        "conflicts_with",
        "final_score",
    )
    result = {k: memory[k] for k in fields if k in memory}
    result["content"] = excerpt(memory["content"], chars)
    result["content_truncated"] = len(result["content"]) < len(memory["content"])
    return result


def bounded_result(result, allowance, chars, *, mutation=False):
    """Drop complete search entries; shrink only explicitly marked text excerpts."""
    if "results" in result:
        result = {
            **result,
            "results": [memory_view(m, chars) for m in result["results"]],
        }
        while result["results"] and wire_bytes(result) > allowance:
            result["results"].pop()
            result["truncated"] = True
    elif "memory" in result:
        result = {**result, "memory": memory_view(result["memory"], min(chars, 800))}
        while wire_bytes(result) > allowance:
            sources = result.get("sources", [])
            if sources and len(sources[0]["content"]) > 50:
                src = sources[0]
                src["content"] = src["content"][: len(src["content"]) // 2]
                src["next_offset"] = src["offset"] + len(src["content"])
                src["truncated"] = True
            elif len(result["memory"]["content"]) > 50:
                result["memory"]["content"] = result["memory"]["content"][
                    : len(result["memory"]["content"]) // 2
                ]
                result["memory"]["content_truncated"] = True
            else:
                break
    if wire_bytes(result) > allowance:
        if mutation:
            return {
                k: result[k]
                for k in ("id", "revision", "status", "task_id")
                if k in result
            } | {
                "action_applied": True,
                "result_truncated": True,
                "message": "操作已保存；完整状态请在预算允许时重新读取。",
            }
        # Preserve task contracts in authority; ask for a fresh turn rather than mutilating constraints.
        result = {
            "status": "evidence_budget_exhausted",
            "message": "本轮证据预算不足；请在新一轮读取。",
        }
    return result


def source_page(source, offset, chars):
    text = source["content"]
    end = min(len(text), offset + chars)
    return {
        k: source[k] for k in ("id", "revision", "role", "content_hash", "status")
    } | {
        "content": text[offset:end],
        "offset": offset,
        "next_offset": end if end < len(text) else None,
        "total_chars": len(text),
        "truncated": offset > 0 or end < len(text),
    }
