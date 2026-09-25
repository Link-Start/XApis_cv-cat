# -*- coding: utf-8 -*-
"""浏览器指纹单一真源：UA / sec-ch-ua / 屏幕参数只在这里定义一次。

对齐 ../DouYin_Spider/utils/fingerprint.py 的做法——所有请求头、所有参数装配都从
get_profile() 取值，避免同一进程里出现两套互相矛盾的浏览器画像。
"""

import random as _rnd

GEO_PRESETS = (
    (1920, 1080),
    (1536, 864),
    (1440, 900),
    (1366, 768),
)

_profile = None


def get_profile():
    """进程级指纹档案（进程内稳定，跨进程随机换屏幕尺寸）。"""
    global _profile
    if _profile is None:
        width, height = _rnd.choice(GEO_PRESETS)
        _profile = {
            # 当前已登录 Chrome 实抓为 153；Castle 与 UI metrics 都把 UA/UA-CH
            # 编进输入，不能继续沿用旧的 146/150 档案。
            "ua": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"),
            "sec_ch_ua": '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
            "sec_ch_ua_mobile": "?0",
            "sec_ch_ua_platform": '"Windows"',
            "accept_language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6",
            "client_language": "zh-CN",
            "timezone": "Asia/Shanghai",
            "screen_width": str(width),
            "screen_height": str(height),
        }
    return _profile


def reset_profile():
    """测试用：强制重新抽取一份档案。"""
    global _profile
    _profile = None
