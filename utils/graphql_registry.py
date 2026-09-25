# -*- coding: utf-8 -*-
"""GraphQL 操作注册表：queryId / features / fieldToggles 的**唯一真源**。

X 的每个 GraphQL 操作都有一个哈希 `queryId`，**随前端发版漂移**；
`features` 少一个键服务端直接 400。把它们写死在方法体里的结果就是——
前端一发版，整个项目集体 404。

所以这里不手抄，直接从线上前端**机器提取**：

- 每个操作在 webpack 里都是一个独立模块，形如
  `{queryId:"...", operationName:"TweetDetail", operationType:"query",
    metadata:{featureSwitches:[...], fieldToggles:[...]}}`；
- 每个开关的**布尔取值**来自 app shell HTML 里的
  `window.__INITIAL_STATE__.featureSwitch.defaultConfig`。

产物落 `static/graphql.json`，运行时只读这个文件；
前端发版后跑 `python main.py refresh-graphql` 重新生成即可。
"""

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from utils.frontend import (fetch_chunk, fetch_shell_html, parse_all_assets,
                            shell_headers)

REGISTRY_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'static', 'graphql.json'))

# {queryId:"xxx",operationName:"Yyy",operationType:"query",metadata:{featureSwitches:[..],fieldToggles:[..]}}
_OPERATION_RE = re.compile(
    r'queryId:"(?P<qid>[\w-]+)",'
    r'operationName:"(?P<name>\w+)",'
    r'operationType:"(?P<type>\w+)",'
    r'metadata:\{featureSwitches:\[(?P<fs>[^\]]*)\],'
    r'fieldToggles:\[(?P<ft>[^\]]*)\]\}')
_STRING_RE = re.compile(r'"([^"]+)"')
_SHA_RE = re.compile(r'"sha":"(\w+)"')

_cache = None


# --------------------------------------------------------------------------- #
# 读取
# --------------------------------------------------------------------------- #

def load(force: bool = False) -> dict:
    global _cache
    if _cache is None or force:
        if not os.path.exists(REGISTRY_PATH):
            raise RuntimeError(
                f'{REGISTRY_PATH} 不存在，先跑 `python main.py refresh-graphql` 生成')
        with open(REGISTRY_PATH, encoding='utf-8') as fp:
            _cache = json.load(fp)
    return _cache


def get_operation(name: str) -> dict:
    """按 operationName 取出 {queryId, operationType, featureSwitches, fieldToggles}。"""
    operations = load()['operations']
    if name not in operations:
        raise KeyError(
            f'注册表里没有操作 {name!r}；可能是前端改名或本地注册表过期，'
            f'跑 `python main.py refresh-graphql` 后重试')
    return operations[name]


def get_query_id(name: str) -> str:
    return get_operation(name)['queryId']


def build_features(name: str, overrides: dict = None) -> dict:
    """按操作声明的开关名，从 defaults 里取出布尔取值，组成 features 对象。"""
    registry = load()
    defaults = registry['featureDefaults']
    operation = get_operation(name)
    features = {switch: defaults.get(switch, False)
                for switch in operation['featureSwitches']}
    if overrides:
        features.update(overrides)
    return features


def build_field_toggles(name: str, overrides: dict = None) -> dict:
    """按操作声明的 fieldToggles 取值。

    注意注册表里的 `fieldToggles` 是该操作**支持**的全集，而浏览器每次调用只发
    其中一个**子集**（哪些键取决于调用点的业务上下文）。需要逐字段对齐浏览器时，
    调用方用 `x_apis` 里各方法的 `toggle_overrides` / `BROWSER_FIELD_TOGGLES`
    显式给定，不要直接用这里的全集。
    """
    registry = load()
    defaults = registry['featureDefaults']
    operation = get_operation(name)
    toggles = {toggle: defaults.get(toggle, False)
               for toggle in operation['fieldToggles']}
    if overrides:
        toggles.update(overrides)
    return toggles


# --------------------------------------------------------------------------- #
# 刷新
# --------------------------------------------------------------------------- #

def _parse_feature_defaults(html: str) -> dict:
    """从 `__INITIAL_STATE__.featureSwitch` 抠出 {开关名: 取值}。

    已登录 app shell 里 `featureSwitch.user.config` 是**用户维度解析后的值**，会覆盖
    `defaultConfig`——浏览器 GraphQL 里发的就是覆盖后的值（实测 34 个开关两者不同）。
    未登录 shell 只有 `defaultConfig`。这里解析整个 featureSwitch，再用 user.config 覆盖。
    """
    anchor = html.find('"featureSwitch":')
    if anchor < 0:
        raise RuntimeError('app shell 里找不到 featureSwitch')
    start = html.index('{', anchor)
    depth, index = 0, start
    while index < len(html):
        if html[index] == '{':
            depth += 1
        elif html[index] == '}':
            depth -= 1
            if depth == 0:
                break
        index += 1
    switch = json.loads(html[start:index + 1])
    merged = {name: entry.get('value')
              for name, entry in (switch.get('defaultConfig') or {}).items()
              if isinstance(entry, dict)}
    user_config = (switch.get('user') or {}).get('config') or {}
    for name, entry in user_config.items():
        if isinstance(entry, dict) and 'value' in entry:
            merged[name] = entry['value']  # 用户解析值覆盖默认值（与浏览器一致）
    return merged


def _fetch_home_shell(auth, proxies: dict = None) -> str:
    """拉**登录态** x.com/home 的 app shell —— 只有它带 `featureSwitch.user.config`
    （用户维度解析后的 feature 取值，浏览器实际发送的就是这套）。"""
    from builder import client
    resp = client.get('https://x.com/home', headers=shell_headers(),
                      cookies=auth.cookie, proxies=proxies, timeout=30)
    resp.raise_for_status()
    return resp.text


def _extract_operations(text: str) -> dict:
    operations = {}
    for match in _OPERATION_RE.finditer(text):
        operations[match.group('name')] = {
            'queryId': match.group('qid'),
            'operationType': match.group('type'),
            'featureSwitches': _STRING_RE.findall(match.group('fs')),
            'fieldToggles': _STRING_RE.findall(match.group('ft')),
        }
    return operations


def refresh(workers: int = 16, proxies: dict = None, verbose: bool = True,
            auth=None) -> dict:
    """全量重建注册表：枚举线上所有 webpack 分片 → 提取操作 → 写 static/graphql.json。

    `auth` 传入已登录会话时，feature 取值改从**登录态 home shell** 解析（含 user.config
    覆盖），与浏览器该账号实际发送的值逐个一致；否则退回未登录 defaultConfig。
    """
    session = requests.Session()
    html = fetch_shell_html(session, proxies)
    assets = parse_all_assets(html)
    defaults = _parse_feature_defaults(html)
    sha_match = _SHA_RE.search(html)

    if auth is not None and getattr(auth, 'is_logged_in', False):
        try:
            defaults = _parse_feature_defaults(_fetch_home_shell(auth, proxies))
            if verbose:
                print('feature 取值：已用登录态 home shell 的 user.config（与浏览器一致）')
        except Exception as exc:
            if verbose:
                print(f'  ! 登录态 feature 取值失败，回退未登录 defaultConfig：{exc}')

    # 图标和翻译分片里不可能有 GraphQL 操作，跳过以省一半流量
    targets = {name: url for name, url in assets.items()
               if not name.startswith(('icons.', 'i18n/'))}
    if verbose:
        print(f'前端 sha={sha_match.group(1) if sha_match else "?"}，'
              f'待扫描分片 {len(targets)} 个（清单共 {len(assets)}）')

    operations = {}
    failures = []

    def worker(item):
        name, url = item
        try:
            return name, _extract_operations(fetch_chunk(url, session, proxies))
        except Exception as exc:
            failures.append((name, str(exc)))
            return name, {}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for done, (name, found) in enumerate(pool.map(worker, targets.items()), 1):
            operations.update(found)
            if verbose and done % 100 == 0:
                print(f'  ...{done}/{len(targets)}，已收集 {len(operations)} 个操作')

    # 只保留被操作引用到的开关，避免把两千多条 defaultConfig 全塞进仓库
    referenced = set()
    for operation in operations.values():
        referenced.update(operation['featureSwitches'])
        referenced.update(operation['fieldToggles'])
    feature_defaults = {name: defaults.get(name, False) for name in sorted(referenced)}

    registry = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'frontendSha': sha_match.group(1) if sha_match else None,
        'operations': dict(sorted(operations.items())),
        'featureDefaults': feature_defaults,
    }

    os.makedirs(os.path.dirname(REGISTRY_PATH), exist_ok=True)
    with open(REGISTRY_PATH, 'w', encoding='utf-8') as fp:
        json.dump(registry, fp, ensure_ascii=False, indent=2)

    global _cache
    _cache = registry
    if verbose:
        print(f'写入 {REGISTRY_PATH}：{len(operations)} 个操作，'
              f'{len(feature_defaults)} 个开关，失败分片 {len(failures)} 个')
        for name, err in failures[:5]:
            print(f'  ! {name}: {err}')
    return registry
