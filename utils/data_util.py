# -*- coding: utf-8 -*-
"""推文结构化、媒体下载与 xlsx 落盘。对齐 ../DouYin_Spider/utils/data_util.py。"""

import os
import re

import openpyxl
import requests

from utils.fingerprint import get_profile

_ILLEGAL_PATH = re.compile(r'[\\/:*?"<>|\r\n\t]')

FIELDS = [
    'work_id', 'work_url', 'work_type', 'title', 'create_time', 'lang',
    'user_id', 'nickname', 'screen_name', 'user_url',
    'like_count', 'retweet_count', 'reply_count', 'quote_count',
    'bookmark_count', 'view_count', 'image_urls', 'video_urls',
]


def safe_name(text: str, limit: int = 60) -> str:
    return _ILLEGAL_PATH.sub('_', (text or '').strip())[:limit] or 'untitled'


def _media_of(legacy: dict):
    """`extended_entities` 才有完整媒体列表，`entities` 只有第一张。"""
    entities = legacy.get('extended_entities') or legacy.get('entities') or {}
    return entities.get('media') or []


def handle_work_info(result: dict) -> dict:
    """把 GraphQL 的 tweet result 拍平成一行记录。"""
    if result.get('__typename') == 'TweetWithVisibilityResults':
        result = result.get('tweet') or result
    legacy = result.get('legacy') or {}
    user = (((result.get('core') or {}).get('user_results') or {}).get('result')) or {}
    user_core = user.get('core') or {}

    images, videos = [], []
    for media in _media_of(legacy):
        if media.get('type') == 'photo':
            images.append(media.get('media_url_https'))
        else:
            variants = ((media.get('video_info') or {}).get('variants')) or []
            mp4 = [v for v in variants if v.get('content_type') == 'video/mp4']
            if mp4:
                videos.append(max(mp4, key=lambda v: v.get('bitrate') or 0)['url'])

    screen_name = user_core.get('screen_name', '')
    work_id = result.get('rest_id') or legacy.get('id_str', '')
    return {
        'work_id': work_id,
        'work_url': f'https://x.com/{screen_name}/status/{work_id}',
        'work_type': 'video' if videos else ('image' if images else 'text'),
        'title': legacy.get('full_text', ''),
        'create_time': legacy.get('created_at', ''),
        'lang': legacy.get('lang', ''),
        'user_id': user.get('rest_id', ''),
        'nickname': user_core.get('name', ''),
        'screen_name': screen_name,
        'user_url': f'https://x.com/{screen_name}',
        'like_count': legacy.get('favorite_count', 0),
        'retweet_count': legacy.get('retweet_count', 0),
        'reply_count': legacy.get('reply_count', 0),
        'quote_count': legacy.get('quote_count', 0),
        'bookmark_count': legacy.get('bookmark_count', 0),
        'view_count': (result.get('views') or {}).get('count', ''),
        'image_urls': images,
        'video_urls': videos,
    }


def download_media(url: str, save_path: str, proxies: dict = None):
    resp = requests.get(url, headers={'user-agent': get_profile()['ua']},
                        proxies=proxies, timeout=120, stream=True)
    resp.raise_for_status()
    with open(save_path, 'wb') as fp:
        for chunk in resp.iter_content(1 << 16):
            fp.write(chunk)
    return save_path


def download_work(work_info: dict, base_path: str, save_choice: str = 'media',
                  proxies: dict = None) -> list:
    """把一条推文的图/视频下载到 `<base_path>/<作者>_<正文片段>/`。"""
    folder = os.path.join(
        base_path, safe_name(f"{work_info['screen_name']}_{work_info['title']}"))
    os.makedirs(folder, exist_ok=True)

    saved = []
    if save_choice in ('all', 'media', 'media-image'):
        for index, url in enumerate(work_info['image_urls']):
            # X 的图片要显式要 orig 才是原图
            target = f'{url}?format=jpg&name=orig'
            saved.append(download_media(target, os.path.join(folder, f'{index}.jpg'),
                                        proxies))
    if save_choice in ('all', 'media', 'media-video'):
        for index, url in enumerate(work_info['video_urls']):
            saved.append(download_media(url, os.path.join(folder, f'{index}.mp4'),
                                        proxies))
    return saved


def save_to_xlsx(work_list: list, file_path: str, fields: list = None):
    fields = fields or FIELDS
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(fields)
    for work in work_list:
        sheet.append(['\n'.join(work.get(f) or []) if isinstance(work.get(f), list)
                      else work.get(f, '') for f in fields])
    book.save(file_path)
    return file_path
