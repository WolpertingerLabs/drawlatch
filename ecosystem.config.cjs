/* global module, __dirname */
module.exports = {
  apps: [
    {
      name: "mcp-secure-proxy",
      script: "dist/remote/server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
