import { test, before } from 'node:test';
import { buildApp } from './src/app.js';

let app: any;
before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { code: 'dbg-code' } });
  console.log('DEBUG status:', res.statusCode, '| body:', res.body.slice(0, 200));
});
test('placeholder', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  console.log('health:', res.statusCode);
});
