'use strict';
// routeGet：只读分享页按 128 位不可猜测 ID 取路线
// body: { id }

const store = require('./store');
const { parseBody, ok, fail } = require('./http');

exports.main = async (event) => {
  const body = parseBody(event) || {};
  const route = await store.routeGet(body.id);
  if (!route) return fail('路线不存在或已过期', 404);
  return ok({ route });
};
