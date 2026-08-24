// queues/connection.js
// Centralised BullMQ Redis connection options.
//
// Notes:
//   - We use ioredis under the hood (BullMQ requirement). The existing
//     `node-redis` client (utils/redis.js) is used for caching/blacklist;
//     a separate ioredis client is created here for the queue.
//   - Connection options are read from REDIS_URL or REDIS_HOST/REDIS_PORT.
//
// Env:
//   REDIS_URL=redis://default:password@host:6379
//   or
//   REDIS_HOST=127.0.0.1
//   REDIS_PORT=6379

const url = process.env.REDIS_URL;

const connection = url
  ? { connection: { url } }
  : {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        // BullMQ requires this to be null so it doesn't auto-quit on idle.
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    };

module.exports = connection;
