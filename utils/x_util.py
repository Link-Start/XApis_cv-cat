# -*- coding: utf-8 -*-
"""X 通用小工具：cookie 解析、ct0 生成、游标提取、URL 解析。"""

import re
import secrets
import uuid

# https://x.com/<screen_name>/status/<tweet_id>
_STATUS_RE = re.compile(r'(?:twitter|x)\.com/(?:#!/)?(\w+)/status(?:es)?/(\d+)')
_SCREEN_NAME_RE = re.compile(r'(?:twitter|x)\.com/@?([A-Za-z0-9_]{1,15})/?(?:\?|$)')


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
