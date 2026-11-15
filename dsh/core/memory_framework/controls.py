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
    content = excerpt(memory["content"], chars)
    truncated = len(content) < len(memory["content"])
    result = {
        "id": memory["id"],
        "content": content,
        "source_ids": memory.get("source_ids", []),
    }
    if truncated:
        result["content_truncated"] = True
    if memory.get("conflicts_with"):
        result["conflicts_with"] = memory["conflicts_with"]
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
    elif "entries" in result:
        result = {**result, "entries": list(result["entries"])}
        while result["entries"] and wire_bytes(result) > allowance:
            # Drop oldest entry in the page first so the tail stays intact, and update next_before_sequence.
            dropped = result["entries"].pop(0)
            result["has_more"] = True
            result["next_before_sequence"] = (
                result["entries"][0]["sequence"]
                if result["entries"]
                else dropped["sequence"] + 1
            )
    elif "source" in result:
        result = {**result, "source": dict(result["source"])}
        while wire_bytes(result) > allowance and len(result["source"]["content"]) > 50:
            src = result["source"]
            src["content"] = src["content"][: len(src["content"]) // 2]
            src["next_offset"] = src["offset"] + len(src["content"])
            src["truncated"] = True
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
        "id": source["id"],
        "role": source["role"],
        "content": text[offset:end],
        "offset": offset,
        "next_offset": end if end < len(text) else None,
        "total_chars": len(text),
        "truncated": offset > 0 or end < len(text),
    }
