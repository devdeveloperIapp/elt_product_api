// PM2 ecosystem — start the API server and the worker side-by-side.
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 reload elt-api          # zero-downtime API reload
//   pm2 restart elt-worker      # restart only the worker

module.exports = {
  apps: [
    {
      name: 'elt-api',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '768M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'elt-worker',
      script: 'workers/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
