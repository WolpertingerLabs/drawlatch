/* global module, __dirname */
module.exports = {
  apps: [
    {
      name: 'drawlatch',
      script: 'dist/remote/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
