"""Message normalization shared without host imports."""
from typing import Any

def content_to_text(content: Any) -> str:
    """Normalize message content to plain text for storage and LLM prompts."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, (int, float, bool)):
        return str(content)
    if isinstance(content, list):
        text_parts: list[str] = []
        saw_media = False
        for part in content:
            part_text, part_has_media = _content_part_to_text(part)
            if part_text:
                text_parts.append(part_text)
            saw_media = saw_media or part_has_media
        text = " ".join(text_parts).strip()
        if text:
            return text
        return "[图片消息]" if saw_media else ""

    text, saw_media = _content_part_to_text(content)
    if text:
        return text
    return "[图片消息]" if saw_media else str(content)

def _content_part_to_text(part: Any) -> tuple[str, bool]:
    if part is None:
        return "", False
    if isinstance(part, str):
        return part, False
    if isinstance(part, (int, float, bool)):
        return str(part), False
    if isinstance(part, list):
        text = content_to_text(part)
        return ("" if text == "[图片消息]" else text), text == "[图片消息]"
    if not isinstance(part, dict):
        return str(part), False

    part_type = str(part.get("type", "")).lower()
    if part_type in {"text", "plain"}:
        return str(part.get("text") or part.get("content") or ""), False
    if "text" in part and isinstance(part.get("text"), str):
        return part["text"], False
    if "content" in part:
        return _content_part_to_text(part.get("content"))
    if "message" in part:
        return _content_part_to_text(part.get("message"))

    media_keys = {"image_url", "image", "file", "audio", "video", "media"}
    if part_type in media_keys or any(key in part for key in media_keys):
        return "", True
    return "", False
