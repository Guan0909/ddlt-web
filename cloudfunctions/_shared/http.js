'use strict';
// HTTP 触发器请求/响应工具

function parseBody(event) {
  try {
    if (event.body == null) return event;
    return typeof event.body === 'string' ? JSON.parse(event.body || '{}') : event.body;
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
