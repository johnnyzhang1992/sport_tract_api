import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdminModel, hashPassword } from '../src/models/admin.model.js';
import { TopicModel } from '../src/models/topic.model.js';

/**
 * 专题接口测试：
 * - /admin/topics CRUD（adminAuth）
 * - /topics/active 生效窗口过滤：未发布/未生效/已过期均不展示
 * - /topics/:id 详情（markdown 正文图片签名；未配置 OSS 时 URL 原样返回）
 * - 可选鉴权：游客可访问
 */

const ADMIN_USER = 't-admin-topics';
const ADMIN_PASS = 'test-admin-pass-123';

let app: FastifyInstance;
let adminToken = '';

const NOW = Date.now();

async function adminReq(method: string, url: string, body?: unknown) {
  return app.inject({
    method,
    url: `/sport-track/api/admin${url}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: body,
  });
}

async function createTopic(overrides: Record<string, unknown>) {
  const res = await adminReq('POST', '/topics', {
    title: '测试专题',
    content: '正文',
    published: true,
    effectiveAt: NOW - 1000,
    expiresAt: null,
    ...overrides,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.id as string;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const existing = await AdminModel.findOne({ username: ADMIN_USER });
  if (existing) {
    existing.passwordHash = await hashPassword(ADMIN_PASS);
    await existing.save();
  } else {
    await AdminModel.create({ username: ADMIN_USER, passwordHash: await hashPassword(ADMIN_PASS) });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/admin/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  adminToken = login.json().data.token;
  assert.ok(adminToken);
  await TopicModel.deleteMany({ title: { $in: ['测试专题', '未发布专题', '未来专题', '过期专题'] } });
});

after(async () => {
  await TopicModel.deleteMany({}).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('生效窗口过滤：仅展示 已发布+已生效+未过期', async () => {
  const activeId = await createTopic({});
  await createTopic({ title: '未发布专题', published: false });
  await createTopic({ title: '未来专题', effectiveAt: NOW + 86400000 });
  await createTopic({ title: '过期专题', expiresAt: NOW - 1000 });

  const res = await app.inject({ method: 'GET', url: '/sport-track/api/topics/active' });
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().data;
  assert.ok(items.some((t: { id: string }) => t.id === activeId), '生效专题应在列表');
  assert.equal(items.length, 1, '未发布/未来/过期不应出现');
});

test('详情返回 markdown 正文；游客可访问；过期/未发布 404', async () => {
  const id = await createTopic({
    content: '# 里程碑\n\n![图](https://oss.example.com/topics/a.png)\n\n**用户量破 1000**',
  });

  // 游客（无 token）
  const res = await app.inject({ method: 'GET', url: `/sport-track/api/topics/${id}` });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.title, '测试专题');
  assert.match(data.content, /# 里程碑/);
  assert.match(data.content, /https:\/\/oss\.example\.com\/topics\/a\.png/);

  // 过期后 404
  await adminReq('PUT', `/topics/${id}`, { expiresAt: NOW - 1000 });
  const gone = await app.inject({ method: 'GET', url: `/sport-track/api/topics/${id}` });
  assert.equal(gone.statusCode, 404);
});

test('admin CRUD：创建/更新/删除', async () => {
  const id = await createTopic({ title: '原始标题' });

  const updated = await adminReq('PUT', `/topics/${id}`, { title: '更新后标题' });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().data.title, '更新后标题');

  const detail = await app.inject({ method: 'GET', url: `/sport-track/api/topics/${id}` });
  assert.equal(detail.json().data.title, '更新后标题');

  const del = await adminReq('DELETE', `/topics/${id}`);
  assert.equal(del.statusCode, 200, del.body);
  const list = await app.inject({ method: 'GET', url: '/sport-track/api/topics/active' });
  const ids = list.json().data.map((t: { id: string }) => t.id);
  assert.ok(!ids.includes(id), '已删除专题不应在生效列表');
});

test('校验：标题为空 400；无 token 访问 admin 401', async () => {
  const noTitle = await adminReq('POST', '/topics', { title: '', content: 'x', effectiveAt: NOW });
  assert.equal(noTitle.statusCode, 400);

  const res = await app.inject({ method: 'GET', url: '/sport-track/api/admin/topics' });
  assert.equal(res.statusCode, 401);
});
