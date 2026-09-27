#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""XApis 快速开始：纯 Python 账密登录后直接搜索内容。

使用方式和 ``../DouYin_Spider/quick_publish.py`` 一样：
只需要准备 `.env` 和同一登录页采集的 Castle profile，然后运行::

    python quickstart.py

脚本不会读取 Chrome，也不会把账密写入源码；登录成功后只将服务端返回的
cookie 持久化到本地 `.env`，供后续 SDK 调用复用。
"""

from __future__ import annotations

import getpass
import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from utils.common_util import detect_system_proxy, save_cookies
from utils.data_util import handle_work_info
from utils.transaction import ClientTransaction
from utils.x_util import extract_tweet_entries
from x_apis.login_api import XJetfuelLoginApi
from x_apis.x_api import XAPI


# ============================== 用户配置 ============================== #
# 也可以全部留空，运行时从 .env 读取；不要把真实账密提交到 Git。
USERNAME = ""
PASSWORD = ""

SEARCH_QUERY = "美国"
SEARCH_PRODUCT = "Top"       # Top / Latest / People / Media
PRINT_LIMIT = 10              # 终端展示的结果条数
PURE_PROFILE_FILE = ""        # 同一登录页采集的完整 Rl/profile JSON


def _unwrap_json_string(value: Any) -> Any:
    """兼容 DevTools evaluate_script 导出的双层 JSON 字符串。"""
    for _ in range(3):
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            break
    return value


def _load_pure_profile(path_value: str) -> Any:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"纯算 profile 不存在：{path}")
    with path.open(encoding="utf-8") as fp:
        profile = _unwrap_json_string(json.load(fp))
    if not isinstance(profile, (dict, list, tuple)):
        raise ValueError("纯算 profile 必须是 Rl 数组、数值键映射或 profile 对象")
    return profile


def _credentials() -> tuple[str, str]:
    username = (USERNAME or os.getenv("X_USERNAME") or "").strip()
    password = PASSWORD or os.getenv("X_PASSWORD") or ""
    if not username:
        username = input("X 用户名：").strip()
    if not password:
        password = getpass.getpass("X 密码：")
    if not username or not password:
        raise ValueError("用户名和密码不能为空；请填写 quickstart.py 或 .env")
    return username, password


def login():
    """执行一次严格纯 Python 登录，返回可直接调用 XAPI 的 Auth。"""
    username, password = _credentials()
    profile_path = (PURE_PROFILE_FILE
                    or os.getenv("CASTLE_PURE_RL_FILE")
                    or "").strip()
    if not profile_path:
        raise ValueError(
            "纯 Python 账密登录需要 CASTLE_PURE_RL_FILE；"
            "请填写同一登录页采集的完整 Castle Rl/profile JSON"
        )

    profile = _load_pure_profile(profile_path)
    proxy = (os.getenv("X_PROXY") or "").strip() or detect_system_proxy()
    proxies = {"http": proxy, "https": proxy} if proxy else None

    print("正在执行纯 Python 账密登录……", flush=True)
    ok, message, auth = XJetfuelLoginApi.login_by_password_pure(
        username,
        password,
        profile,
        proxies=proxies,
    )
    if not ok:
        raise RuntimeError(f"登录失败：{message}")

    save_cookies(auth.cookie_str)
    print("登录成功，cookie 已持久化到 .env。", flush=True)
    return auth


def search(auth):
    """登录后搜索配置的关键词，并打印可读摘要。"""
    query = (os.getenv("X_SEARCH_QUERY") or SEARCH_QUERY).strip()
    product = (os.getenv("X_SEARCH_PRODUCT") or SEARCH_PRODUCT).strip()
    if not query:
        raise ValueError("SEARCH_QUERY 不能为空")
    if product not in {"Top", "Latest", "People", "Media"}:
        raise ValueError("SEARCH_PRODUCT 必须是 Top、Latest、People 或 Media")

    # 搜索不应因为再次抓取前端 shell 而依赖浏览器或额外网络；登录页缓存
    # 的公共 XCTID 素材足够构造这个真实 GraphQL 请求。
    auth._transaction = ClientTransaction.from_cached()
    result = XAPI.search_work(auth, query, product=product)
    if result.get("errors") or not result.get("data"):
        raise RuntimeError(f"搜索返回错误：{result.get('errors') or '缺少 data'}")

    entries = extract_tweet_entries(result)
    print(f"搜索成功：{query!r}，类型={product}，结果={len(entries)} 条", flush=True)
    for index, entry in enumerate(entries[:PRINT_LIMIT], 1):
        work = handle_work_info(entry)
        title = " ".join((work.get("title") or "").split())
        print(
            f"{index:>2}. @{work.get('screen_name') or 'unknown'} "
            f"{title[:120]}\n    {work.get('work_url')}",
            flush=True,
        )
    return result


def _configure_stdio() -> None:
    """让 Windows 默认终端也能打印搜索结果里的 emoji/多语言文本。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    _configure_stdio()
    load_dotenv()
    try:
        auth = login()
        search(auth)
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - CLI 入口统一报告错误
        print(f"快速搜索失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
