# -*- coding: utf-8 -*-
"""接口层异常。"""


class GraphQLError(RuntimeError):
    """GraphQL 在 HTTP 200 里回了 errors。

    X 的 GraphQL 失败**不用 HTTP 状态码表达**——删除别人的推文、会话过期（code 32）、
    触发限流（code 226 / 344），都是 200 + `{"errors": [...]}`。
    不显式检查就会把失败当成功。
    """

    def __init__(self, operation_name: str, errors: list, res_json: dict = None):
        self.operation_name = operation_name
        self.errors = errors or []
        self.res_json = res_json
        self.code = (self.errors[0] or {}).get('code') if self.errors else None
        message = '; '.join(str((e or {}).get('message') or e) for e in self.errors)
        super().__init__(f'{operation_name}: {message}')
