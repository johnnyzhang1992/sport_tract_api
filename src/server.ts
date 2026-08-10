import { buildApp } from './app.js';
import { config } from './config/index.js';

async function start() {
  const fastify = await buildApp();

  try {
    await fastify.listen({ port: config.port, host: config.host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
