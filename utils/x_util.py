# -*- coding: utf-8 -*-
"""X 通用小工具：cookie 解析、ct0 生成、游标提取、URL 解析。"""

import re
import secrets
import uuid

# https://x.com/<screen_name>/status/<tweet_id>
_STATUS_RE = re.compile(r'(?:twitter|x)\.com/(?:#!/)?(\w+)/status(?:es)?/(\d+)')
_SCREEN_NAME_RE = re.compile(r'(?:twitter|x)\.com/@?([A-Za-z0-9_]{1,15})/?(?:\?|$)')


# twitter-text v3 的计数配置：普通推上限 280 权重；
# 落在下面几个区间里的字符（拉丁、常用标点）算 1，其余（CJK、emoji 等）算 2；
# 链接不论多长一律按 23 计。
TWEET_WEIGHT_LIMIT = 280
_URL_WEIGHT = 23
_LIGHT_RANGES = ((0, 4351), (8192, 8205), (8208, 8223), (8242, 8247))
# 中文正文里链接后面常直接跟全角标点，遇到 CJK 标点 / 全角字符即视为链接结束
_URL_RE = re.compile(r'https?://[^\s\u3000-\u303f\uff00-\uffef]+', re.IGNORECASE)
# emoji 序列里的「修饰」码点：不单独计数，整个 emoji 只算一次 2
_EMOJI_JOINERS = {0x200D, 0xFE0E, 0xFE0F, 0x20E3}


def _char_weight(cp: int) -> int:
    return 1 if any(lo <= cp <= hi for lo, hi in _LIGHT_RANGES) else 2


def tweet_weight(text: str) -> int:
    """按 twitter-text v3 规则计算推文权重（网页端右下角那个圈）。

    `> 280` 时普通 `CreateTweet` 会被拒，需要 Premium 的 `CreateNoteTweet`。
    """
    text = text or ''
    weight, cursor = 0, 0
    for match in _URL_RE.finditer(text):
        weight += _plain_weight(text[cursor:match.start()]) + _URL_WEIGHT
        cursor = match.end()
    return weight + _plain_weight(text[cursor:])


def _plain_weight(text: str) -> int:
    weight, joined = 0, False
    for ch in text:
        cp = ord(ch)
        if cp in _EMOJI_JOINERS or 0x1F3FB <= cp <= 0x1F3FF:
            # ZWJ 之后紧跟的码点属于同一个 emoji，不再计数
            joined = cp == 0x200D
            continue
        if joined:
            joined = False
            continue
        weight += _char_weight(cp)
    return weight


def trans_cookies(cookies_str: str) -> dict:
    """"a=1; b=2" -> {'a': '1', 'b': '2'}；容忍空串与结尾分号。"""
    cookies = {}
    for item in (cookies_str or '').split(';'):
        item = item.strip()
        if not item or '=' not in item:
            continue
        key, value = item.split('=', 1)
        cookies[key.strip()] = value.strip()
    return cookies


def cookies_to_str(cookies: dict) -> str:
    return '; '.join(f'{k}={v}' for k, v in cookies.items())


def generate_ct0() -> str:
    """ct0 是前端自己生成的 32 位十六进制随机串，同时写 Cookie 和 x-csrf-token 头。"""
    return secrets.token_hex(16)


def generate_client_uuid() -> str:
    return str(uuid.uuid4())


def parse_tweet_id(url_or_id: str) -> str:
    """接受完整推文链接或纯数字 id，统一返回数字 id。"""
    text = (url_or_id or '').strip()
    if text.isdigit():
        return text
    match = _STATUS_RE.search(text)
    if not match:
        raise ValueError(f'无法从 {url_or_id!r} 解析推文 id')
    return match.group(2)


def parse_screen_name(url_or_name: str) -> str:
    """接受主页链接、@handle 或裸用户名，统一返回小写 screen_name。"""
    text = (url_or_name or '').strip().rstrip('/')
    match = _SCREEN_NAME_RE.search(text)
    if match:
        return match.group(1).lower()
    return text.lstrip('@').split('/')[-1].split('?')[0].lower()


def _walk_entries(node):
    """深度遍历 timeline 响应，产出所有 entry 字典。"""
    if isinstance(node, dict):
        if 'entryId' in node and 'content' in node:
            yield node
        for value in node.values():
            yield from _walk_entries(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk_entries(value)


def extract_cursor(res_json: dict, direction: str = 'Bottom'):
    """从任意 timeline 响应里抠出游标。

    X 的游标散落在 instructions / entries / itemContent 的不同层级，且不同接口层级不同，
    所以这里不写死路径，直接按 cursorType 匹配整棵树。找不到返回 None。
    """
    for entry in _walk_entries(res_json or {}):
        content = entry.get('content') or {}
        for holder in (content, content.get('itemContent') or {}):
            if not isinstance(holder, dict):
                continue
            if holder.get('cursorType') == direction and holder.get('value'):
                return holder['value']
    return None


def extract_tweet_entries(res_json: dict) -> list:
    """从 timeline 响应里挑出真正的推文条目（跳过游标、广告位、模块占位）。"""
    results = []
    for entry in _walk_entries(res_json or {}):
        entry_id = entry.get('entryId', '')
        if not entry_id.startswith('tweet-'):
            continue
        content = entry.get('content') or {}
        item = content.get('itemContent') or {}
        result = (item.get('tweet_results') or {}).get('result')
        if result:
            results.append(result)
    return results
