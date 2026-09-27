# -*- coding: utf-8 -*-
"""XApis CLI —— 登录 / 发作品 / 看详情 / 搜索 / 维护注册表。

    python main.py whoami
    python main.py detail  <推文id或链接>
    python main.py user    <用户名>
    python main.py search  "关键词" [--product Latest]
    python main.py post    "正文" [--image a.jpg --image b.png] [--reply-to <id>]
    python main.py post    --file long.txt          # 超过 280 权重自动走长推
    python main.py thread  --file thread.md         # 单独一行 --- 分隔每条
    python main.py article article.md [--cover banner.png] [--publish]
    python main.py article-list [--published]
    python main.py article-delete <文章id>
    python main.py delete  <推文id>
    python main.py spider  <用户名> [--pages 3] [--save all]
    python main.py refresh-graphql
    python main.py refresh-castle [--check]
    python main.py login

对齐 ../DouYin_Spider/main.py 的定位：既是入口，也是每条链路的最小可运行示例。
"""

import argparse
import json
import os
import re
import sys

from loguru import logger

from utils.common_util import clear_cookies, init, save_cookies
from utils.data_util import handle_work_info, download_work, save_to_xlsx
from utils.x_util import (TWEET_WEIGHT_LIMIT, extract_cursor, extract_tweet_entries,
                          parse_screen_name, trans_cookies, tweet_weight)
from x_apis.errors import GraphQLError
from x_apis.x_api import XAPI
from x_apis.x_article_api import REPLY_MODES, XArticleAPI
from x_apis.x_write_api import XWriteAPI


def _dump(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def cmd_whoami(auth, args):
    if not auth.is_logged_in:
        logger.error('.env 里的 X_COOKIES 没有 auth_token，会话未登录')
        return 1
    result = XAPI.get_viewer(auth)['data']['viewer']['user_results']['result']
    logger.info(f"@{result['core']['screen_name']} ({result['rest_id']}) "
                f"{result['core']['name']}")
    return 0


def cmd_detail(auth, args):
    res_json = XAPI.get_work_info(auth, args.work)
    entries = extract_tweet_entries(res_json)
    if not entries:
        logger.error('没有解析到推文，可能是私密账号或已删除')
        return 1
    _dump(handle_work_info(entries[0]))
    logger.info(f'同页评论 {len(entries) - 1} 条')
    return 0


def cmd_user(auth, args):
    res_json = XAPI.get_user_info(auth, args.name)
    result = res_json['data']['user']['result']
    _dump({
        'rest_id': result['rest_id'],
        'name': result['core']['name'],
        'screen_name': result['core']['screen_name'],
        'followers': (result.get('relationship_counts') or {}).get('followers'),
        'tweets': (result.get('tweet_counts') or {}).get('tweets'),
        'description': (result.get('profile_bio') or {}).get('description'),
    })
    return 0


def cmd_search(auth, args):
    res_json = XAPI.search_work(auth, args.query, product=args.product)
    works = [handle_work_info(item) for item in extract_tweet_entries(res_json)]
    for work in works:
        logger.info(f"{work['work_url']}  {work['title'][:60]}")
    logger.info(f'共 {len(works)} 条')
    return 0


def _read_text(text, file):
    if file:
        with open(file, encoding='utf-8') as fp:
            return fp.read().strip()
    return text


def cmd_post(auth, args):
    text = _read_text(args.text, args.file)
    if not text:
        logger.error('正文为空：给 text 参数或 --file')
        return 1
    note = True if args.note else None
    weight = tweet_weight(text)
    if note or weight > TWEET_WEIGHT_LIMIT:
        logger.info(f'权重 {weight} > {TWEET_WEIGHT_LIMIT}，按长推（CreateNoteTweet）发送')
    success, msg, res_json = XWriteAPI.post_tweet(
        auth, text, images=args.image, reply_to=args.reply_to,
        quote_url=args.quote, note=note)
    if not success:
        logger.error(f'发布失败：{msg}')
        return 1
    work_id = XWriteAPI.extract_tweet_id(res_json)
    logger.info(f'发布成功 https://x.com/i/status/{work_id}')
    return 0


def cmd_thread(auth, args):
    texts = list(args.texts or [])
    if args.file:
        # 文件里用单独一行 --- 分隔每条推文
        texts += [part.strip() for part in
                  re.split(r'^\s*---\s*$', _read_text(None, args.file), flags=re.M)
                  if part.strip()]
    if len(texts) < 2:
        logger.error('thread 至少要两条：多个 text 参数，或 --file 里用 --- 分隔')
        return 1
    success, msg, tweet_ids = XWriteAPI.post_thread(
        auth, texts, reply_to=args.reply_to, interval=args.interval)
    for tweet_id in tweet_ids:
        logger.info(f'https://x.com/i/status/{tweet_id}')
    if not success:
        logger.error(f'thread 中断：{msg}')
        return 1
    logger.info(f'thread 发布成功，共 {len(tweet_ids)} 条')
    return 0


def cmd_article(auth, args):
    markdown = _read_text(None, args.file)
    success, msg, info = XArticleAPI.post_article(
        auth, markdown, title=args.title, cover=args.cover,
        publish=args.publish, tweet_text=args.caption or '',
        reply_mode=args.reply_mode, article_id=args.article_id,
        base_dir=os.path.dirname(os.path.abspath(args.file)))
    if info.get('edit_url'):
        logger.info(f"草稿 {info['edit_url']}")
    if not success:
        logger.error(f'文章失败：{msg}')
        return 1
    if args.publish:
        logger.info(f"文章已发布 https://x.com/i/status/{info['tweet_id']}")
    else:
        logger.info('已存为草稿，去网页上预览确认后再发布（或加 --publish）')
    return 0


def cmd_article_list(auth, args):
    res_json = XArticleAPI.list_articles(
        auth, lifecycle='Published' if args.published else 'Draft',
        count=args.count)
    slice_ = res_json['data']['user']['result'].get('articles_article_mixer_slice') or {}
    items = slice_.get('items') or []
    for item in items:
        result = ((item or {}).get('article_entity_results') or {}).get('result') or {}
        logger.info(f"{result.get('rest_id')}  {result.get('title')!r}  "
                    f"{(result.get('lifecycle_state') or {}).get('lifecycle')}")
    logger.info(f'共 {len(items)} 篇')
    return 0


def cmd_article_delete(auth, args):
    _dump(XArticleAPI.delete(auth, args.article_id))
    return 0


def cmd_delete(auth, args):
    _dump(XWriteAPI.delete_tweet(auth, args.work))
    return 0


def cmd_spider(auth, args):
    _, base_path = init()
    screen_name = parse_screen_name(args.name)
    user_id = XAPI.get_user_id(auth, screen_name)

    works, cursor = [], None
    for _ in range(args.pages):
        res_json = XAPI.get_user_post_note(auth, user_id, cursor=cursor)
        works.extend(handle_work_info(item)
                     for item in extract_tweet_entries(res_json))
        next_cursor = extract_cursor(res_json, 'Bottom')
        if not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor

    logger.info(f'@{screen_name} 抓到 {len(works)} 条作品')
    if args.save in ('all', 'media', 'media-image', 'media-video'):
        for work in works:
            download_work(work, base_path['media'], args.save, auth.proxies)
    if args.save in ('all', 'excel'):
        path = os.path.join(base_path['excel'], f'{screen_name}.xlsx')
        save_to_xlsx(works, path)
        logger.info(f'已写入 {path}')
    return 0


def cmd_refresh_graphql(auth, args):
    from utils.graphql_registry import refresh
    registry = refresh(proxies=auth.proxies, auth=auth)
    logger.info(f"注册表更新完成：{len(registry['operations'])} 个操作")
    return 0


def cmd_refresh_castle(auth, args):
    from utils import castle_refresh
    if args.check:
        report = castle_refresh.check(proxies=auth.proxies)
        return 1 if report['drifted'] else 0
    try:
        meta = castle_refresh.refresh(proxies=auth.proxies)
    except Exception as exc:
        logger.error(f'{type(exc).__name__}: {exc}')
        return 1
    logger.info(f"castle 生成器已刷新：公钥={meta['public_key']} token前缀={meta['token_prefix']}")
    return 0


_AUTH_FAILURE_CODES = {32, 89, 215, 326}


def _saved_cookie_is_valid(auth) -> bool:
    """用一个真实 Viewer 请求确认本地 auth_token 仍可用。"""
    if not auth.auth_token:
        return False
    try:
        # Cookie reuse must not depend on a fresh app-shell scrape.  The
        # checked-in public XCTID materials are enough for this validation
        # request and keep the offline/pure-Python path deterministic.
        if getattr(auth, '_transaction', None) is None:
            from utils.transaction import ClientTransaction
            auth._transaction = ClientTransaction.from_cached()
        result = XAPI.get_viewer(auth)
    except GraphQLError as exc:
        if exc.code in _AUTH_FAILURE_CODES:
            return False
        message = str(exc).lower()
        if any(marker in message for marker in
               ('unauthorized', 'authentication', 'expired token',
                'invalid token', 'not authorized')):
            return False
        raise
    except Exception as exc:
        # curl_cffi and requests both attach the HTTP response to transport
        # errors.  Only clear credentials for an explicit auth status; a
        # timeout or proxy failure must not destroy a still-valid cookie.
        response = getattr(exc, 'response', None)
        if response is not None and getattr(response, 'status_code', None) in (401, 403):
            return False
        raise
    try:
        return bool(result['data']['viewer']['user_results']['result']['rest_id'])
    except (KeyError, TypeError):
        return False


def cmd_login(auth, args):
    from x_apis.login_api import LoginChallenge, XJetfuelLoginApi

    force = bool(args.force or
                 (os.getenv('X_LOGIN_FORCE') or '').strip().lower()
                 in ('1', 'true', 'yes'))
    if not force and auth.auth_token:
        try:
            if _saved_cookie_is_valid(auth):
                logger.info('本地登录凭证仍有效，已复用 cookie；如需重登请使用 --force')
                return 0
        except Exception as exc:
            logger.error(f'校验本地 cookie 失败，未清除凭证：{type(exc).__name__}: {exc}')
            return 1
        clear_cookies()
        logger.info('本地 cookie 已过期，已清除，开始纯 Python 重登')

    username = args.username or os.getenv('X_USERNAME')
    password = args.password or os.getenv('X_PASSWORD')
    if not username or not password:
        logger.error('缺少用户名/密码：命令行传入或写进 .env')
        return 1

    # 密码登录默认使用干净会话；把 .env 里的 auth_token/twid/ct0 再塞进
    # begin_login 会形成“已登录 cookie + 密码流”的混合状态，服务端会拒绝，
    # 也无法验证纯算登录。需要专门做浏览器 cookie 对拍时显式设置
    # X_LOGIN_BROWSER_COOKIES=1。
    browser_cookies = None
    visible_override = (os.getenv('X_LOGIN_VISIBLE_COOKIES') or '').strip()
    visible_file = (os.getenv('X_LOGIN_VISIBLE_COOKIES_FILE') or '').strip()
    if not visible_override and visible_file:
        try:
            with open(visible_file, encoding='utf-8') as fp:
                visible_override = fp.read().strip()
            if visible_override.startswith('"'):
                visible_override = json.loads(visible_override)
        except (OSError, ValueError, TypeError):
            visible_override = ''
    if visible_override:
        captured = trans_cookies(visible_override)
        browser_cookies = {
            str(key): str(value) for key, value in captured.items()
            if str(key) not in {'auth_token', 'twid', 'ct0'} and value
        }
    elif (not force and
          (os.getenv('X_LOGIN_BROWSER_COOKIES') or '').strip().lower()
          in ('1', 'true', 'yes')):
        browser_cookies = auth.cookie
    pure_rl_values = None
    pure_rl_path = args.pure_rl or os.getenv('CASTLE_PURE_RL_FILE')
    # The CLI is a pure-computation entry point by default.  The old Node
    # runner remains available only through an explicit compatibility switch;
    # supplying a profile always wins and stays strict even if that switch is
    # accidentally present.
    pure_required = (not args.compat_node) or bool(pure_rl_path) or args.pure_only or (
        (os.getenv('CASTLE_PURE_ONLY') or '').strip().lower()
        in ('1', 'true', 'yes'))
    if pure_rl_path:
        try:
            with open(pure_rl_path, encoding='utf-8') as fp:
                pure_rl_values = json.load(fp)
            # DevTools evaluate_script exports a returned JSON object as a
            # JSON string one level deeper.  Unwrap that shape before handing
            # the profile to the strict Python Castle path.
            for _ in range(3):
                if not isinstance(pure_rl_values, str):
                    break
                try:
                    pure_rl_values = json.loads(pure_rl_values)
                except (TypeError, ValueError):
                    break
            if isinstance(pure_rl_values, dict) and 'rl' in pure_rl_values:
                if not isinstance(pure_rl_values['rl'], (dict, list, tuple)):
                    raise ValueError('纯算 profile 的 rl 必须是对象或数组')
            logger.info('已启用显式纯算 Castle 路径：{}（要求同一页面的完整 Rl 或 serialized raw profile；旧版 632 槽/当前 749 槽）',
                        pure_rl_path)
            # A browser capture may carry the same page's visible cookie
            # header.  Reuse it for the jetfuel transport when the caller did
            # not explicitly request .env auth cookies; never mix auth_token,
            # twid, or ct0 into a fresh password flow.
            if browser_cookies is None and isinstance(pure_rl_values, dict):
                captured = (pure_rl_values.get('browser_cookies')
                            or pure_rl_values.get('cookie'))
                if isinstance(captured, str):
                    captured = trans_cookies(captured)
                if isinstance(captured, dict):
                    browser_cookies = {
                        str(k): str(v) for k, v in captured.items()
                        if str(k) not in {'auth_token', 'twid', 'ct0'} and v
                    }
        except (OSError, ValueError, TypeError) as exc:
            logger.error(f'读取纯算 profile 文件失败：{type(exc).__name__}: {exc}')
            return 1
    try:
        api = XJetfuelLoginApi(proxies=auth.proxies,
                               browser_cookies=browser_cookies,
                               pure_rl_values=pure_rl_values,
                               pure_required=pure_required)
    except (OSError, ValueError, TypeError) as exc:
        logger.error(f'{type(exc).__name__}: {exc}')
        return 1
    try:
        logged_auth = api.login(username, password)
    except LoginChallenge as exc:
        logger.warning(f'登录需要人工验证：{exc}')
        logger.info('账号触发二次验证/人机验证（jetfuel 挑战），当前需人工在浏览器完成。')
        return 1
    except Exception as exc:
        logger.error(f'{type(exc).__name__}: {exc}')
        logger.info('若是限流请退避几分钟重试；也可浏览器登录后把 cookie 串写进 .env 的 X_COOKIES。')
        return 1
    save_cookies(logged_auth.cookie_str)
    logger.info(f'登录成功（user_id={logged_auth.user_id}），凭据已写回 .env 的 X_COOKIES')
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog='main.py', description='XApis 命令行入口')
    sub = parser.add_subparsers(dest='command', required=True)

    sub.add_parser('whoami', help='校验当前会话').set_defaults(func=cmd_whoami)

    p = sub.add_parser('detail', help='作品详情')
    p.add_argument('work')
    p.set_defaults(func=cmd_detail)

    p = sub.add_parser('user', help='用户信息')
    p.add_argument('name')
    p.set_defaults(func=cmd_user)

    p = sub.add_parser('search', help='搜索作品')
    p.add_argument('query')
    p.add_argument('--product', default='Top', choices=['Top', 'Latest', 'People',
                                                        'Media'])
    p.set_defaults(func=cmd_search)

    p = sub.add_parser('post', help='发作品（超过 280 权重自动按长推发）')
    p.add_argument('text', nargs='?')
    p.add_argument('--file', help='从文件读正文，适合长推')
    p.add_argument('--image', action='append', help='可重复，最多 4 张')
    p.add_argument('--reply-to', dest='reply_to')
    p.add_argument('--quote')
    p.add_argument('--note', action='store_true',
                   help='强制按长推（CreateNoteTweet）发，默认按权重自动判断')
    p.set_defaults(func=cmd_post)

    p = sub.add_parser('thread', help='发 thread（每条回复上一条）')
    p.add_argument('texts', nargs='*')
    p.add_argument('--file', help='文件里用单独一行 --- 分隔每条')
    p.add_argument('--reply-to', dest='reply_to', help='整串挂在这条推文下面')
    p.add_argument('--interval', type=float, default=2.0, help='两条之间间隔秒数')
    p.set_defaults(func=cmd_thread)

    p = sub.add_parser('article', help='从 Markdown 写文章（默认只存草稿）')
    p.add_argument('file', help='Markdown 文件；第一行 `# 标题` 会被拆成文章标题')
    p.add_argument('--title', help='文章标题，不给则取正文第一行的 # 标题')
    p.add_argument('--cover', help='封面图，建议 5:2')
    p.add_argument('--publish', action='store_true', help='写完直接发布')
    p.add_argument('--caption', help='发布时附带的推文说明文字（≤256 字）')
    p.add_argument('--reply-mode', dest='reply_mode', choices=REPLY_MODES,
                   help='谁可以回复，默认所有人')
    p.add_argument('--article-id', dest='article_id', help='覆盖更新这篇已有草稿')
    p.set_defaults(func=cmd_article)

    p = sub.add_parser('article-list', help='列出文章草稿 / 已发布')
    p.add_argument('--published', action='store_true')
    p.add_argument('--count', type=int, default=20)
    p.set_defaults(func=cmd_article_list)

    p = sub.add_parser('article-delete', help='删除文章（不可撤销）')
    p.add_argument('article_id')
    p.set_defaults(func=cmd_article_delete)

    p = sub.add_parser('delete', help='删除作品')
    p.add_argument('work')
    p.set_defaults(func=cmd_delete)

    p = sub.add_parser('spider', help='抓取用户作品并落盘')
    p.add_argument('name')
    p.add_argument('--pages', type=int, default=2)
    p.add_argument('--save', default='excel',
                   choices=['all', 'excel', 'media', 'media-image', 'media-video',
                            'none'])
    p.set_defaults(func=cmd_spider)

    sub.add_parser('refresh-graphql', help='从线上前端重建 static/graphql.json') \
        .set_defaults(func=cmd_refresh_graphql)

    p = sub.add_parser('refresh-castle',
                       help='从线上拉 castle SDK 重打补丁（纯算）；--check 只做漂移检测')
    p.add_argument('--check', action='store_true', help='只读漂移检测，不改文件')
    p.set_defaults(func=cmd_refresh_castle)

    p = sub.add_parser('login', help='用户名+密码登录（web jetfuel 流）')
    p.add_argument('--username')
    p.add_argument('--password')
    p.add_argument('--pure-rl', metavar='FILE',
                   help='同一浏览器采集的完整 Rl 或 serialized raw profile JSON（旧版 632 槽/当前 749 槽）')
    p.add_argument('--pure-only', action='store_true',
                   help='强制纯算；没有 --pure-rl/profile 时直接失败，绝不回退 Node')
    p.add_argument('--compat-node', action='store_true',
                   help='显式启用旧 Node Castle runner（仅兼容，不属于纯算验收）')
    p.add_argument('--force', action='store_true',
                   help='忽略本地 cookie，强制重新走纯 Python 账密登录')
    p.set_defaults(func=cmd_login)

    return parser


def main():
    args = build_parser().parse_args()
    auth, _ = init()
    return args.func(auth, args)


if __name__ == '__main__':
    sys.exit(main())
