# -*- coding: utf-8 -*-
"""XArticleAPI：X 文章（Article，Premium 长文）的草稿与发布。

网页端文章编辑器（x.com/compose/articles）的完整链路，2026-09-27 Chrome 实抓::

    ArticleEntityDraftCreate       点「新建」，建一个空草稿
    ArticleEntityUpdateTitle       改标题（防抖自动保存）
    ArticleEntityUpdateContent     改正文（防抖自动保存，整篇 content_state 覆盖）
    upload.x.com INIT/APPEND/FINALIZE   封面 / 插图上传，不发 metadata/create
    ArticleEntityUpdateCoverMedia  设封面
    ArticleEntityPublish           发布（同时生成一条带文章卡片的推文）
    ArticleEntityDelete            删除
    ArticleEntitiesSlice           草稿 / 已发布列表（GET）

几个容易踩的点：

1. 同一个文章 id，不同操作里的变量名不一样：`articleEntityId`（标题 / 封面 /
   发布 / 删除）和 `article_entity`（正文）。
2. 这组操作都**不发 fieldToggles**，见 `builder/params.BROWSER_FIELD_TOGGLES`。
3. 正文结构见 `utils/article_util`。

单步方法返回 `res_json`；编排入口 `post_article` 返回 `(success, msg, info)`。
"""

import base64
import os

from utils.article_util import (MEDIA_CATEGORY, markdown_to_content_state,
                                split_title)
from x_apis.x_api import graphql_get
from x_apis.x_write_api import graphql_post

X_HOST = 'https://x.com'
COMPOSE_URL = f'{X_HOST}/compose/articles'

# 发布弹窗「谁可以回复？」下拉框的取值；All（每个人）时浏览器不发这个字段
REPLY_MODES = ('All', 'Community', 'Verified', 'ByInvitation')


def edit_url(article_id: str) -> str:
    return f'{COMPOSE_URL}/edit/{article_id}'


class XArticleAPI:

    # ---- 单步 ----------------------------------------------------------- #

    @staticmethod
    def create_draft(auth, title: str = '', content_state: dict = None,
                     **kwargs) -> dict:
        """新建草稿。浏览器点「新建」时发的是空标题 + 空正文。"""
        return graphql_post(auth, 'ArticleEntityDraftCreate', {
            'content_state': content_state or {'blocks': [], 'entity_map': []},
            'title': title,
        }, referer=COMPOSE_URL)

    @staticmethod
    def extract_article_id(res_json: dict) -> str:
        """从任意 ArticleEntity* 响应里取出文章 rest_id。

        响应里的 `id` 是 relay 全局 id：base64("ArticleEntity:<rest_id>")。
        """
        for value in ((res_json or {}).get('data') or {}).values():
            if not isinstance(value, dict):
                continue
            # 建草稿的结果包了一层 article_entity_results.result，其余操作直接给实体
            result = (value.get('article_entity_results') or {}).get('result', value)
            if result.get('rest_id'):
                return result['rest_id']
            if result.get('id'):
                decoded = base64.b64decode(result['id'] + '==').decode()
                return decoded.split(':', 1)[1]
        raise KeyError(f'响应里没有文章 id：{res_json}')

    @staticmethod
    def update_title(auth, article_id: str, title: str, **kwargs) -> dict:
        return graphql_post(auth, 'ArticleEntityUpdateTitle', {
            'articleEntityId': str(article_id),
            'title': title,
        }, referer=edit_url(article_id))

    @staticmethod
    def update_content(auth, article_id: str, content_state: dict,
                       **kwargs) -> dict:
        """整篇覆盖正文。注意这里文章 id 的键名是 `article_entity`。"""
        return graphql_post(auth, 'ArticleEntityUpdateContent', {
            'content_state': content_state,
            'article_entity': str(article_id),
        }, referer=edit_url(article_id))

    @staticmethod
    def update_cover(auth, article_id: str, media_id: str, **kwargs) -> dict:
        """设封面。编辑器建议 5:2 的图，其他比例会被裁。"""
        return graphql_post(auth, 'ArticleEntityUpdateCoverMedia', {
            'articleEntityId': str(article_id),
            'coverMedia': {'media_id': str(media_id),
                           'media_category': MEDIA_CATEGORY},
        }, referer=edit_url(article_id))

    @staticmethod
    def publish(auth, article_id: str, tweet_text: str = '',
                reply_mode: str = None, visibility: str = 'Public',
                **kwargs) -> dict:
        """发布草稿。

        :param tweet_text: 发布弹窗里的「说明文字」，会作为那条文章推文的正文
            （最多 256 字，文章链接由服务端自动附上）。
        :param reply_mode: 谁可以回复，取值见 `REPLY_MODES`；None / All = 所有人。
        """
        # 说明文字为空时浏览器直接不带 tweetText，而不是发空串
        variables = {'articleEntityId': str(article_id)}
        if tweet_text:
            variables['tweetText'] = tweet_text
        variables['visibilitySetting'] = visibility
        if reply_mode and reply_mode != 'All':
            if reply_mode not in REPLY_MODES:
                raise ValueError(f'reply_mode 只能是 {REPLY_MODES}')
            variables['conversationControl'] = {'mode': reply_mode}
        return graphql_post(auth, 'ArticleEntityPublish', variables,
                            referer=edit_url(article_id))

    @staticmethod
    def extract_tweet_id(res_json: dict) -> str:
        """从 ArticleEntityPublish 响应里取出发布时生成的那条推文 id。"""
        result = res_json['data']['articleentity_publish'][
            'article_entity_results']['result']
        return result['metadata']['tweet_results']['result']['rest_id']

    @staticmethod
    def delete(auth, article_id: str, **kwargs) -> dict:
        """删除草稿或已发布文章（不可撤销）。

        已发布的文章删除后，发布时生成的那条推文也会一起消失（2026-09-27 实测）。
        """
        return graphql_post(auth, 'ArticleEntityDelete',
                            {'articleEntityId': str(article_id)},
                            referer=edit_url(article_id))

    @staticmethod
    def list_articles(auth, lifecycle: str = 'Draft', count: int = 20,
                      user_id: str = None, cursor: str = None, **kwargs) -> dict:
        """文章列表。lifecycle：`Draft`（草稿）/ `Published`（已发布）。"""
        variables = {'userId': user_id or auth.user_id,
                     'lifecycle': lifecycle, 'count': count}
        if cursor:
            variables['cursor'] = cursor
        return graphql_get(auth, 'ArticleEntitiesSlice', variables,
                           referer=COMPOSE_URL)

    @staticmethod
    def upload_image(auth, path: str, **kwargs) -> str:
        """文章封面 / 插图上传：与发推同一套分片上传，但不登记 metadata。"""
        from x_apis.x_media_api import XMediaAPI
        return XMediaAPI.upload(auth, path, with_metadata=False,
                                referer=COMPOSE_URL)

    # ---- 编排 ----------------------------------------------------------- #

    @staticmethod
    def post_article(auth, markdown: str = None, title: str = None,
                     content_state: dict = None, cover: str = None,
                     publish: bool = False, tweet_text: str = '',
                     reply_mode: str = None, base_dir: str = None,
                     article_id: str = None, **kwargs):
        """从 Markdown 写一篇文章：建草稿 → 传图 → 标题 → 正文 → 封面 →（可选）发布。

        :param markdown: 正文。第一行是 `# 标题` 且没给 title 时，自动拆出来当标题。
        :param content_state: 直接给 Draft.js 结构时忽略 markdown。
        :param cover: 封面图路径（建议 5:2）。
        :param publish: False 只存草稿，方便到网页上预览后再手动发。
        :param base_dir: markdown 里图片相对路径的基准目录。
        :param article_id: 给出时更新这篇已有草稿，而不是新建。
        :return: (success, msg, info)。info 至少包含 article_id / edit_url，
            发布时还有 tweet_id 和 publish 响应 raw。
        """
        info = {}
        try:
            if content_state is None:
                if title is None:
                    title, markdown = split_title(markdown or '')
                content_state = markdown_to_content_state(
                    markdown or '',
                    upload_image=lambda path: XArticleAPI.upload_image(auth, path),
                    base_dir=base_dir)
            if not title:
                raise ValueError('文章标题不能为空：传 title，或让正文第一行是 `# 标题`')

            if not article_id:
                article_id = XArticleAPI.extract_article_id(
                    XArticleAPI.create_draft(auth))
            info.update(article_id=article_id, edit_url=edit_url(article_id))

            XArticleAPI.update_title(auth, article_id, title)
            XArticleAPI.update_content(auth, article_id, content_state)
            if cover:
                if base_dir and not os.path.isabs(cover):
                    cover = os.path.join(base_dir, cover)
                XArticleAPI.update_cover(auth, article_id,
                                         XArticleAPI.upload_image(auth, cover))
            if publish:
                info['raw'] = XArticleAPI.publish(auth, article_id, tweet_text,
                                                  reply_mode=reply_mode)
                info['tweet_id'] = XArticleAPI.extract_tweet_id(info['raw'])
            return True, '成功', info
        except Exception as exc:
            return False, f'{type(exc).__name__}: {exc}', info
