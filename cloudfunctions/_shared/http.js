'use strict';
// HTTP 触发器请求/响应工具

function parseBody(event) {
  try {
    if (event.body == null) return event;
    let raw = event.body;
    // HTTP 访问服务在非 JSON Content-Type（我们前端的「简单请求」用 text/plain 绕 CORS 预检）时
    // 会把 body 以 base64 传进来，这里统一解码后再解析
    if (event.isBase64Encoded && typeof raw === 'string') {
      try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) {}
    }
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return {};
      return JSON.parse(s);
    }
    return raw;
  } catch (e) { return null; }
}

function ok(obj) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj),
  };
}

function fail(message, code = 400, extra) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message, ...(extra || {}) }),
  };
}

module.exports = { parseBody, ok, fail };
