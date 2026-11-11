"""Chinese recall expansion extracted from the existing BM25 retriever."""
import re
_CJK_RUN = re.compile(r"[一-鿿]+")

def with_cjk_bigrams(tokens: list[str], text: str) -> list[str]:
    """在分词结果后追加中文连续段的字符二元组。

    短查询与专有名词（店名/人名/型号）经常被 jieba 切得与索引侧不一致，
    字符二元组能补上这种细粒度匹配；英文与数字段不加，避免引入噪声。

    Args:
        tokens: jieba 分词结果
        text: 原始文本

    Returns:
        追加二元组后的词元列表（去重保序）
    """
    merged = list(tokens)
    for match in _CJK_RUN.finditer(str(text or "")):
        run = match.group(0)
        merged.extend(run[i : i + 2] for i in range(len(run) - 1))
    return list(dict.fromkeys(merged))
