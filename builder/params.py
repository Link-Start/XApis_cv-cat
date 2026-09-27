# -*- coding: utf-8 -*-
"""GraphQL 请求装配：variables / features / fieldToggles 一处生成。

queryId 与 features **不写死在方法体里**，全部从 static/graphql.json（由
utils/graphql_registry 从线上前端机器提取）取值——否则前端一发版整个项目集体 404。

用法::

    op = GraphQLOperation('TweetDetail')
    url = op.url()
    params = op.query_params({'focalTweetId': '123'})
"""

import json

from utils.graphql_registry import build_features, build_field_toggles, get_operation

GRAPHQL_BASE = 'https://x.com/i/api/graphql'

# 哨兵：区分「没登记」和「登记为不发」
_UNSET = object()

# 浏览器在各操作上**实际发送**的 fieldToggles 子集（2026-08-15 实抓）。
# 注册表里的 fieldToggles 是该操作**支持**的全集，比这里多——
# 直接发全集虽然目前服务端也收，但与真实客户端不一致。
# None 表示浏览器不发 fieldToggles 参数。
# 2026-08-16 Chrome DevTools 实抓——各操作浏览器实际发送的 fieldToggles 子集。
# None 表示浏览器不发 fieldToggles 参数；没登记的操作退回注册表全集（保守兜底）。
BROWSER_FIELD_TOGGLES = {
    'SearchTimeline': None,
    'HomeTimeline': None,
    'CreateTweet': None,
    # 2026-09-27 Chrome 实抓：长推（Premium，>280 权重）走 CreateNoteTweet，
    # body 形态与 CreateTweet 相同，同样不发 fieldToggles。
    'CreateNoteTweet': None,
    # 2026-09-27 Chrome 实抓：文章编辑器全链路（建草稿 / 改标题 / 改正文 /
    # 改封面 / 发布 / 删除 / 草稿列表）都不发 fieldToggles，
    # 虽然注册表里声明了 withPayments / withAuxiliaryUserLabels。
    'ArticleEntityDraftCreate': None,
    'ArticleEntityUpdateTitle': None,
    'ArticleEntityUpdateContent': None,
    'ArticleEntityUpdateCoverMedia': None,
    'ArticleEntityPublish': None,
    'ArticleEntityDelete': None,
    'ArticleEntitiesSlice': None,
    'UserByScreenName': {'withPayments': False, 'withAuxiliaryUserLabels': True},
    # UserTweets 是旧回退操作；浏览器 profile 页当前用 UserOriginalsTimeline。
    # 两者都保留，但旧操作的当前 toggle 形状需要单独实抓，不在这里臆合并。
    'UserTweets': {'withArticlePlainText': False},
    # Chrome 153 访问公开主页时的当前请求：withPayments 也会显式出现，
    # 且顺序在 withArticlePlainText 之前。UserTweets 是旧回退操作，暂不把
    # 未实抓到的字段强行套过去。
    'UserOriginalsTimeline': {
        'withPayments': False,
        'withArticlePlainText': False,
    },
    'TweetDetail': {
        'withPayments': False,
        'withArticleRichContentState': True,
        'withArticlePlainText': False,
        'withArticleSummaryText': True,
        'withArticleVoiceOver': True,
        'withGrokAnalyze': False,
        'withDisallowedReplyControls': False,
    },
    # 详情页同时发出的结果补水请求（TweetResultByRestId），实抓只带这
    # 五个 toggle，顺序与详情请求不同，不能复用 TweetDetail 的全集。
    'TweetResultByRestId': {
        'withArticleRichContentState': True,
        'withArticlePlainText': False,
        'withArticleSummaryText': True,
        'withArticleVoiceOver': True,
        'withPayments': False,
    },
}


def _compact(payload) -> str:
    """GraphQL 参数要求紧凑 JSON（无多余空格），与前端序列化保持一致。"""
    return json.dumps(payload, separators=(',', ':'), ensure_ascii=False)


class GraphQLOperation:
    """一个 GraphQL 操作的完整请求形态。"""

    def __init__(self, name: str):
        self.name = name
        self.meta = get_operation(name)

    @property
    def query_id(self) -> str:
        return self.meta['queryId']

    @property
    def is_mutation(self) -> bool:
        return self.meta['operationType'] == 'mutation'

    def path(self) -> str:
        """XCTID 要的 pathname，必须与真实请求路径一致且不含 query。"""
        return f'/i/api/graphql/{self.query_id}/{self.name}'

    def url(self) -> str:
        return f'{GRAPHQL_BASE}/{self.query_id}/{self.name}'

    def features(self, overrides: dict = None) -> dict:
        return build_features(self.name, overrides)

    def field_toggles(self, overrides: dict = None) -> dict:
        """该操作的 fieldToggles。

        `overrides` 传 `{}` 之外的字典时按注册表全集叠加；
        想**精确控制发哪几个键**（浏览器就是发子集），用 `exact_field_toggles`。
        """
        return build_field_toggles(self.name, overrides)

    @staticmethod
    def exact_field_toggles(toggles: dict) -> dict:
        """原样使用给定的 fieldToggles，不与注册表全集合并。"""
        return dict(toggles)

    @property
    def browser_field_toggles(self):
        """浏览器在该操作上实际发送的 fieldToggles 子集（实抓基线）。

        `None` 表示浏览器**不发** fieldToggles 这个参数。
        没登记的操作退回注册表全集（保守做法，至少不会缺键）。
        """
        return BROWSER_FIELD_TOGGLES.get(self.name, _UNSET)

    def query_params(self, variables: dict, feature_overrides: dict = None,
                     toggle_overrides: dict = None,
                     field_toggles=_UNSET) -> dict:
        """GET 型（query）操作的 query string 参数。

        `field_toggles` 显式给定时原样使用（`None` = 不发这个参数）；
        不给就用浏览器实抓的子集，再退回注册表全集。
        `features` 为空时同样不带这个参数。
        """
        params = {'variables': _compact(variables)}
        features = self.features(feature_overrides)
        if features:
            params['features'] = _compact(features)
        toggles = self._resolve_toggles(field_toggles, toggle_overrides)
        if toggles:
            params['fieldToggles'] = _compact(toggles)
        return params

    def _resolve_toggles(self, field_toggles, toggle_overrides):
        if field_toggles is not _UNSET:
            return dict(field_toggles) if field_toggles else None
        browser = self.browser_field_toggles
        if browser is not _UNSET:
            if browser is None:
                return None
            toggles = dict(browser)
            if toggle_overrides:
                toggles.update(toggle_overrides)
            return toggles
        return self.field_toggles(toggle_overrides)

    def json_body(self, variables: dict, feature_overrides: dict = None,
                  toggle_overrides: dict = None,
                  field_toggles=_UNSET) -> dict:
        """POST 型操作的请求体。

        `features` 只在该操作**确实声明了开关**时才带 —— 浏览器发
        `FavoriteTweet` / `CreateRetweet` 这类互动 mutation 时 body 里
        只有 `variables` + `queryId`，硬塞一个空 features 就与真实请求不一致。
        """
        body = {'variables': variables}
        features = self.features(feature_overrides)
        if features:
            body['features'] = features
        toggles = self._resolve_toggles(field_toggles, toggle_overrides)
        if toggles:
            body['fieldToggles'] = toggles
        body['queryId'] = self.query_id
        return body


class Params:
    """普通 REST 接口（`/1.1/*`、`/i/api/1.1/*`）的 query 装配。"""

    def __init__(self):
        self.params = {}

    def add_param(self, key, value):
        self.params[key] = value
        return self

    def update_params(self, params: dict):
        self.params.update(params)
        return self

    def get(self) -> dict:
        return self.params

    def to_string(self) -> str:
        return '&'.join(f'{k}={v}' for k, v in self.params.items())
