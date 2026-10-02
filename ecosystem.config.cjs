/**
 * PM2 process definition for the CanHook MCP server.
 *
 * Runs the built service from this folder (NOT the web docroot — it is
 * reverse-proxied by OpenLiteSpeed, never served as files). Binds loopback
 * only; public traffic must arrive via https://canhook.com/mcp.
 *
 * Deploy:
 *   git pull && npm run build && pm2 reload canhook-mcp
 * First run:
 *   pm2 start ecosystem.config.cjs && pm2 save
 */
module.exports = {
  apps: [
    {
      name: "canhook-mcp",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
