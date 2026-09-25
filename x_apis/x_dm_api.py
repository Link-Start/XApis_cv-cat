# -*- coding: utf-8 -*-
"""X Chat / 私信启动链路。

当前网页端的私信已经切到 ``X Chat``，不是旧的 ``/1.1/dm/*`` 接口：

* ``GenerateXChatTokenMutation`` 在 ``api.x.com`` 下发短期 chat token；
* ``xChatDmSettingsQuery`` 读取 DM 权限；
* ``GetUsersByIdsForXChat`` 读取聊天成员资料。

新 X Chat 在真正加载收件箱、发送消息前要求用户设置端到端加密 passcode。
没有 passcode 时，网页只会显示欢迎页；因此这里先把可验证的启动请求封装好，
不会伪造或跳过端到端密钥，也不会把 token 持久化到磁盘。
"""

from builder import client
from builder.header import Header, HeaderBuilder, HeaderType


XCHAT_ORIGIN = 'https://api.x.com'
XCHAT_GRAPHQL = f'{XCHAT_ORIGIN}/graphql'
XWEB_ORIGIN = 'https://x.com'
XWEB_GRAPHQL = f'{XWEB_ORIGIN}/i/api/graphql'

GENERATE_TOKEN_QID = 'Qh3fZRjPPtPoHYR_2sCZsA'
DM_SETTINGS_QID = 'mRmm_3aCzCcbpzBkhyhCDg'
MEMBERS_QID = '4zbPmRwsca859ORbYCLyzg'
PUBLIC_KEYS_QID = 'C-YphxeIcPLOGtFNGhkuOw'
INITIAL_PAGE_QID = 'm1gzpOV8JFOTaFH0Xq7lMQ'
CONVERSATION_PAGE_QID = 'GX9ZijkxG8AqRMQVD7hMnQ'

DEFAULT_QUERY_SETTINGS = {
    'conversation_event_limit': 200,
    'inbox_conversation_event_limit': 5,
    'inbox_conversation_limit': 20,
    'user_event_limit': 500,
}


class XChatPasscodeRequired(RuntimeError):
    """网页端要求先设置 X Chat passcode，才能继续收件箱或发消息。"""


def _external_headers(auth, path: str, *, accept='application/json',
                      content_type=None, apollo=False):
    """api.x.com X Chat 请求的显式头，按 Chrome 实抓排列。"""
    order = [
        'authorization', 'x-csrf-token', 'referer',
        'apollo-require-preflight', 'x-client-transaction-id',
        'x-twitter-auth-type', 'accept', 'content-type', 'origin',
    ]
    h = Header(order=order)
    h.with_bearer(auth).with_csrf(auth).set_referer('https://x.com/')
    h.with_xctid(auth, 'POST' if content_type else 'GET', path)
    h.with_auth_type(auth)
    if apollo:
        h.set_header('apollo-require-preflight', 'true')
    if accept:
        h.set_header('accept', accept)
    if content_type:
        h.set_header('content-type', content_type)
    h.set_origin('https://x.com')
    return h.get()


class XChatAPI:

    @staticmethod
    def generate_chat_token(auth) -> str:
        """请求当前会话的 X Chat 短期 token（不落盘）。"""
        path = f'/graphql/{GENERATE_TOKEN_QID}/GenerateXChatTokenMutation'
        headers = _external_headers(auth, path, content_type='application/json')
        resp = client.post(
            f'{XCHAT_ORIGIN}{path}', headers=headers, cookies=auth.cookie,
            json={'variables': '{}'}, proxies=auth.proxies, timeout=30)
        resp.raise_for_status()
        data = resp.json().get('data') or {}
        result = data.get('user_get_x_chat_auth_token') or {}
        token = result.get('token')
        if not token:
            raise RuntimeError(f'X Chat token 响应缺 token：{resp.text[:300]}')
        return token

    @staticmethod
    def get_dm_settings(auth) -> dict:
        """读取当前账号的 DM / X Chat 权限设置。"""
        path = f'/i/api/graphql/{DM_SETTINGS_QID}/xChatDmSettingsQuery'
        headers = (HeaderBuilder.build(HeaderType.POST)
                   .with_bearer(auth).with_csrf(auth).with_auth_type(auth)
                   .with_client_language(auth)
                   .with_xctid(auth, 'GET', path)
                   .set_referer('https://x.com/i/chat').get())
        resp = client.get(
            f'{XWEB_ORIGIN}{path}', headers=headers, cookies=auth.cookie,
            params={'variables': '{}'}, proxies=auth.proxies, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        if payload.get('errors'):
            raise RuntimeError(f'X Chat settings 错误：{payload["errors"]}')
        return payload

    @staticmethod
    def get_users_by_ids(auth, user_ids) -> dict:
        """读取 X Chat 成员信息（Apollo GraphQL）。"""
        path = f'/graphql/{MEMBERS_QID}/GetUsersByIdsForXChat'
        variables = {'ids': [str(uid) for uid in user_ids],
                     'with_social_proof': False}
        headers = _external_headers(auth, path, apollo=True)
        resp = client.get(
            f'{XCHAT_ORIGIN}{path}', headers=headers, cookies=auth.cookie,
            params={'variables': _compact(variables)},
            proxies=auth.proxies, timeout=30)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def get_public_keys(auth, user_ids) -> dict:
        """读取 X Chat 公钥查询（进入会话页时浏览器会发）。"""
        path = f'/graphql/{PUBLIC_KEYS_QID}/GetPublicKeysQuery'
        variables = {
            'ids': [str(uid) for uid in user_ids],
            'include_juicebox_tokens': True,
        }
        headers = _external_headers(auth, path, apollo=True)
        resp = client.get(
            f'{XCHAT_ORIGIN}{path}', headers=headers, cookies=auth.cookie,
            params={'variables': _compact(variables)},
            proxies=auth.proxies, timeout=30)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def get_initial_chat_page(auth, *, max_local_sequence_id=None,
                              message_pull_version=None,
                              query_settings=None) -> dict:
        """读取 X Chat 收件箱初始页（真实 GET GraphQL 请求）。"""
        path = f'/graphql/{INITIAL_PAGE_QID}/GetInitialXChatPageQuery'
        variables = {
            'max_local_sequence_id': max_local_sequence_id,
            'query_settings': dict(query_settings or DEFAULT_QUERY_SETTINGS),
            'message_pull_version': message_pull_version,
        }
        headers = _external_headers(auth, path, apollo=True)
        resp = client.get(
            f'{XCHAT_ORIGIN}{path}', headers=headers, cookies=auth.cookie,
            params={'variables': _compact(variables)},
            proxies=auth.proxies, timeout=30)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def get_conversation_page(auth, conversation_id: str, *,
                              min_local_sequence_id=9223372036854775807,
                              min_conversation_key_version=9223372036854775807,
                              query_settings=None) -> dict:
        """读取单个 X Chat 会话页；不发送消息。"""
        path = f'/graphql/{CONVERSATION_PAGE_QID}/GetConversationPageQuery'
        variables = {
            'conversation_id': str(conversation_id),
            'min_local_sequence_id': str(min_local_sequence_id),
            'min_conversation_key_version': str(min_conversation_key_version),
            'query_settings': dict(query_settings or DEFAULT_QUERY_SETTINGS),
        }
        headers = _external_headers(auth, path, apollo=True)
        resp = client.get(
            f'{XCHAT_ORIGIN}{path}', headers=headers, cookies=auth.cookie,
            params={'variables': _compact(variables)},
            proxies=auth.proxies, timeout=30)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def bootstrap(auth, user_ids=None, conversation_id=None) -> dict:
        """完成网页进入私信页时的可复现读取请求（不发送消息）。"""
        ids = list(user_ids or [auth.user_id])
        result = {
            'chat_token': XChatAPI.generate_chat_token(auth),
            'settings': XChatAPI.get_dm_settings(auth),
            'initial_page': XChatAPI.get_initial_chat_page(auth),
            'members': XChatAPI.get_users_by_ids(auth, ids),
            'public_keys': XChatAPI.get_public_keys(auth, ids),
            'passcode_required': False,
        }
        if conversation_id:
            result['conversation'] = XChatAPI.get_conversation_page(
                auth, conversation_id)
        return result

    @staticmethod
    def send_message(*args, **kwargs):
        """发送消息的占位保护：先在浏览器设置 passcode 再继续逆向。"""
        raise XChatPasscodeRequired(
            '当前 X Chat 要求先在 https://x.com/i/chat 设置 passcode；'
            '设置后才能抓到端到端加密的 inbox/send-message 请求')


def _compact(payload):
    import json
    return json.dumps(payload, separators=(',', ':'), ensure_ascii=False)
