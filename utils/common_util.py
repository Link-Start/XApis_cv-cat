# -*- coding: utf-8 -*-
"""环境装载与目录初始化。对齐 ../DouYin_Spider/utils/common_util.py。"""

import os

from dotenv import load_dotenv

x_auth = None


def detect_system_proxy() -> str:
    """探测代理。

    浏览器能连上 x.com 而 Python 直连超时，多半是因为出网要过本机代理，
    而浏览器读了代理设置、Python 没读。按优先级探测：

    1. 标准环境变量（HTTPS_PROXY / ALL_PROXY，跨平台）；
    2. Windows 注册表 Internet Settings（`ProxyEnable` 打开时才算数）；
    3. 本机常见代理端口是否有人在听（Clash / V2Ray 这类客户端常把系统开关关着、
       只让浏览器走扩展或 PAC，注册表里因此读不到——但端口是实实在在开着的）。

    返回 `''` 表示直连。
    """
    for var in ('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
        value = os.getenv(var)
        if value:
            return value

    if os.name == 'nt':
        try:
            import winreg
            key_path = r'Software\Microsoft\Windows\CurrentVersion\Internet Settings'
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                if winreg.QueryValueEx(key, 'ProxyEnable')[0]:
                    server = (winreg.QueryValueEx(key, 'ProxyServer')[0] or '').strip()
                    if '=' in server:  # "http=h:p;https=h:p" 的分协议写法
                        mapping = dict(p.split('=', 1)
                                       for p in server.split(';') if '=' in p)
                        server = mapping.get('https') or mapping.get('http') or ''
                    if server:
                        return server if '://' in server else f'http://{server}'
        except (ImportError, OSError, FileNotFoundError):
            pass

    return _probe_local_proxy()


# Clash / Mihomo(7897,7890)、V2Ray / Xray(10809,10808)、通用(1080,8080)
_LOCAL_PROXY_PORTS = (7897, 7890, 10809, 10808, 1080, 8080)


def _probe_local_proxy(timeout: float = 0.15) -> str:
    """看本机有没有代理在听。只连一下就断，不发请求，很快。"""
    import socket
    for port in _LOCAL_PROXY_PORTS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                return f'http://127.0.0.1:{port}'
        except OSError:
            continue
        finally:
            sock.close()
    return ''


def load_env():
    """从 .env 读凭据，装配出全局 XAuth。

    代理取值顺序：`.env` 的 `X_PROXY` > 系统代理 > 直连。
    """
    global x_auth
    load_dotenv()
    from builder.auth import XAuth

    proxy = (os.getenv('X_PROXY') or '').strip() or detect_system_proxy()
    proxies = {'http': proxy, 'https': proxy} if proxy else None

    x_auth = XAuth(proxies=proxies)
    x_auth.prepare_auth(os.getenv('X_COOKIES') or '')
    return x_auth


def init():
    media_base_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', 'datas', 'media_datas'))
    excel_base_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', 'datas', 'excel_datas'))
    for base_path in (media_base_path, excel_base_path):
        os.makedirs(base_path, exist_ok=True)
    auth = load_env()
    return auth, {'media': media_base_path, 'excel': excel_base_path}


def save_cookies(cookies_str: str, env_path: str = None):
    """把登录拿到的 cookie 回写 .env 的 X_COOKIES，下次直接复用会话。"""
    env_path = env_path or os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '.env'))
    lines, replaced = [], False
    if os.path.exists(env_path):
        with open(env_path, encoding='utf-8') as fp:
            for line in fp:
                if line.startswith('X_COOKIES='):
                    lines.append(f"X_COOKIES='{cookies_str}'\n")
                    replaced = True
                else:
                    lines.append(line)
    if not replaced:
        lines.append(f"X_COOKIES='{cookies_str}'\n")
    with open(env_path, 'w', encoding='utf-8') as fp:
        fp.writelines(lines)
    return env_path


def clear_cookies(env_path: str = None):
    """从本地 .env 删除已失效的 X_COOKIES，避免反复复用坏会话。"""
    env_path = env_path or os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '.env'))
    if not os.path.exists(env_path):
        return env_path
    with open(env_path, encoding='utf-8') as fp:
        lines = fp.readlines()
    with open(env_path, 'w', encoding='utf-8') as fp:
        fp.writelines(line for line in lines
                      if not line.lstrip().startswith('X_COOKIES='))
    return env_path
