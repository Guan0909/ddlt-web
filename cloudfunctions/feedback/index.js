'use strict';
// feedback：景点卡「信息有误」反馈
// body: { spotId?, routeId?, text }

const store = require('./store');
const { parseBody, ok, fail } = require('./http');

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event) || {};
  const text = String(body.text || '').trim();
  if (!text) return fail('反馈内容为空');
  try {
    await store.feedbackSave(body);
    return ok({ saved: true });
  } catch (e) {
    console.error(e);
    return fail('提交失败，请稍后再试', 500);
  }
};
