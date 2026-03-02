#!/usr/bin/env node

// ── Drawlatch CLI ─────────────────────────────────────────────────
// Entry point for the `drawlatch` command after global npm install.
// Provides daemon management for the remote server, key generation,
// log viewing, config introspection — all with zero extra dependencies.
// ───────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths & constants ─────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = join(PKG_ROOT, "dist/remote/server.js");
const GENERATE_KEYS_ENTRY = join(PKG_ROOT, "dist/cli/generate-keys.js");

// Import config helpers from compiled drawlatch code
const { getConfigDir, getEnvFilePath, loadRemoteConfig } = await import(
  join(PKG_ROOT, "dist/shared/config.js")
);

const CONFIG_DIR = getConfigDir();
const ENV_FILE = getEnvFilePath();
const PID_FILE = join(CONFIG_DIR, "drawlatch.pid");
const LOG_DIR = join(CONFIG_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "drawlatch.log");

// Read version from package.json
const pkgJson = JSON.parse(
  readFileSync(join(PKG_ROOT, "package.json"), "utf-8"),
);
const VERSION = pkgJson.version;

// ── Argument parsing ──────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const subcommand =
  rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.shift() : null;

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    args: rawArgs,
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      foreground: { type: "boolean", short: "f", default: false },
      tunnel: { type: "boolean", short: "t", default: false },
      port: { type: "string" },
      host: { type: "string" },
      lines: { type: "string", short: "n", default: "50" },
      follow: { type: "boolean", default: false },
      path: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  }));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// ── Dispatch ──────────────────────────────────────────────────────
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}
if (values.help && !subcommand) {
  printHelp();
  process.exit(0);
}

switch (subcommand) {
  case null:
    await cmdDefault();
    break;
  case "start":
    if (values.help) {
      printStartHelp();
    } else {
      await cmdStart();
    }
    break;
  case "stop":
    if (values.help) {
      printStopHelp();
    } else {
      await cmdStop();
    }
    break;
  case "restart":
    if (values.help) {
      printRestartHelp();
    } else {
      await cmdRestart();
    }
    break;
  case "status":
    if (values.help) {
      printStatusHelp();
    } else {
      await cmdStatus();
    }
    break;
  case "logs":
    if (values.help) {
      printLogsHelp();
    } else {
      await cmdLogs();
    }
    break;
  case "config":
    if (values.help) {
      printConfigHelp();
    } else {
      cmdConfig();
    }
    break;
  case "generate-keys":
    if (values.help) {
      printGenerateKeysHelp();
    } else {
      await cmdGenerateKeys();
    }
    break;
  case "help":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${subcommand}\n`);
    printHelp();
    process.exit(1);
}

// ── Commands ──────────────────────────────────────────────────────

async function cmdDefault() {
  const pid = readPid();
  if (pid) {
    await cmdStatus();
  } else {
    console.log("Drawlatch remote server is not running.\n");
    printHelp();
  }
}

async function cmdStart() {
  if (values.foreground) return cmdStartForeground();

  ensureConfigDir();

  const existingPid = readPid();
  if (existingPid) {
    console.log(`Remote server is already running (PID ${existingPid}).`);
    console.log(`  Use: drawlatch status`);
    process.exit(0);
  }

  const config = loadRemoteConfig();
  const port = values.port ? parseInt(values.port, 10) : config.port;
  const host = values.host || config.host;

  mkdirSync(LOG_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      NODE_ENV: "production",
      ...(values.port ? { DRAWLATCH_PORT: String(port) } : {}),
      ...(values.host ? { DRAWLATCH_HOST: host } : {}),
      ...(values.tunnel ? { DRAWLATCH_TUNNEL: "1" } : {}),
    },
    cwd: PKG_ROOT,
  });

  writeFileSync(PID_FILE, String(child.pid) + "\n");
  child.unref();

  console.log(`Starting drawlatch remote server on ${host}:${port}...`);
  const healthy = await waitForHealth(host, port, 5000);

  if (healthy) {
    console.log(`\nRemote server is running (PID ${child.pid}).`);
    console.log(`  Listening: ${host}:${port}`);
    if (values.tunnel) {
      // The tunnel starts asynchronously after the server is healthy —
      // poll the health endpoint until the tunnel URL appears (up to 20s).
      console.log(`  Tunnel:    waiting for cloudflared...`);
      const tunnelUrl = await waitForTunnelUrl(host, port, 20000);
      if (tunnelUrl) {
        console.log(`  Tunnel:    ${tunnelUrl}`);
        console.log(`  Webhooks:  ${tunnelUrl}/webhooks/<path>`);
      } else {
        console.log(`  Tunnel:    not available (check logs: drawlatch logs)`);
      }
    }
    console.log(`  Logs:      drawlatch logs`);
  } else {
    console.log(
      `\nServer started (PID ${child.pid}) but health check did not pass.`,
    );
    console.log(`  Check logs: drawlatch logs`);
    await diagnoseStartFailure();
  }
}

async function cmdStartForeground() {
  process.env.NODE_ENV = process.env.NODE_ENV || "production";
  if (values.port) process.env.DRAWLATCH_PORT = values.port;
  if (values.host) process.env.DRAWLATCH_HOST = values.host;
  if (values.tunnel) process.env.DRAWLATCH_TUNNEL = "1";

  ensureConfigDir();

  const { main } = await import(SERVER_ENTRY);
  main();
}

async function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log("Remote server is not running.");
    process.exit(0);
  }

  console.log(`Stopping remote server (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already gone
    cleanPidFile();
    console.log("Server stopped.");
    return;
  }

  const stopped = await waitForExit(pid, 5000);
  if (!stopped) {
    console.log("Server did not stop gracefully, sending SIGKILL...");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone
    }
  }

  cleanPidFile();
  console.log("Server stopped.");
}

async function cmdRestart() {
  const pid = readPid();
  if (pid) {
    // If the previous server had an active tunnel, carry the flag forward
    // so the restarted server also starts a tunnel (unless --tunnel is
    // already set or the user explicitly omitted it).
    if (!values.tunnel) {
      const config = loadRemoteConfig();
      const prevHealth = await healthCheckFull(config.host, config.port);
      if (prevHealth?.tunnelUrl) {
        console.log("Previous server had an active tunnel — re-enabling --tunnel.");
        values.tunnel = true;
      }
    }
    await cmdStop();
  }
  await cmdStart();
}

async function cmdStatus() {
  const pid = readPid();
  if (!pid) {
    console.log("Drawlatch remote server is not running.");
    process.exit(0);
  }

  const config = loadRemoteConfig();
  const port = config.port;
  const host = config.host;

  let uptime = "unknown";
  try {
    const pidStat = await stat(PID_FILE);
    uptime = formatUptime(Date.now() - pidStat.mtimeMs);
  } catch {
    // Can't stat PID file
  }

  const healthData = await healthCheckFull(host, port);

  console.log("Drawlatch remote server is running.");
  console.log(`  PID:             ${pid}`);
  console.log(`  Listening:       ${host}:${port}`);
  console.log(`  Uptime:          ${uptime}`);
  console.log(
    `  Health:          ${healthData ? "healthy" : "unhealthy (not responding)"}`,
  );
  if (healthData) {
    console.log(`  Active sessions: ${healthData.activeSessions}`);
    if (healthData.tunnelUrl) {
      console.log(`  Tunnel:          ${healthData.tunnelUrl}`);
    }
  }
}

async function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found. Start the server first:");
    console.log("  drawlatch start");
    process.exit(0);
  }

  const lines = parseInt(values.lines, 10) || 50;
  const follow = values.follow;

  const tailArgs = follow
    ? ["-n", String(lines), "-f", LOG_FILE]
    : ["-n", String(lines), LOG_FILE];

  const tail = spawn("tail", tailArgs, { stdio: "inherit" });

  tail.on("error", () => {
    // Fallback: read last N lines with Node.js if tail is not available
    try {
      const content = readFileSync(LOG_FILE, "utf-8");
      const allLines = content.split("\n");
      const lastLines = allLines.slice(-lines).join("\n");
      console.log(lastLines);
      if (follow) {
        console.log(
          "\n(Live following not available \u2014 'tail' command not found)",
        );
      }
    } catch (err) {
      console.error(`Error reading log file: ${err.message}`);
      process.exit(1);
    }
  });

  // Forward SIGINT to cleanly exit
  process.on("SIGINT", () => {
    tail.kill();
    process.exit(0);
  });

  // Wait for tail to exit (when using --no-follow)
  await new Promise((res) => tail.on("close", res));
}

function cmdConfig() {
  ensureConfigDir();

  if (values.path) {
    console.log(join(CONFIG_DIR, "remote.config.json"));
    return;
  }

  const config = loadRemoteConfig();

  console.log(`\nDrawlatch Configuration`);
  console.log(`=======================`);

  console.log(`\nRemote Server:`);
  console.log(`  Host:               ${config.host}`);
  console.log(`  Port:               ${config.port}`);
  console.log(`  Rate limit:         ${config.rateLimitPerMinute} req/min`);
  console.log(`  Local keys dir:     ${config.localKeysDir}`);

  const callerEntries = Object.entries(config.callers || {});
  console.log(`  Callers:            ${callerEntries.length}`);
  for (const [alias, caller] of callerEntries) {
    console.log(
      `    ${alias}: ${caller.connections ? caller.connections.length : 0} connection(s)`,
    );
  }

  console.log(
    `  Connectors:         ${config.connectors ? config.connectors.length : 0}`,
  );

  console.log(`\nPaths:`);
  console.log(`  Config dir:  ${CONFIG_DIR}`);
  console.log(`  Env file:    ${ENV_FILE}`);
  console.log(`  Remote cfg:  ${join(CONFIG_DIR, "remote.config.json")}`);
  console.log(`  Proxy cfg:   ${join(CONFIG_DIR, "proxy.config.json")}`);
  console.log(`  Logs:        ${LOG_FILE}`);
  console.log(`  PID file:    ${PID_FILE}`);
  console.log();
}

async function cmdGenerateKeys() {
  // Forward all remaining positional args to the generate-keys script
  const child = spawn(process.execPath, [GENERATE_KEYS_ENTRY, ...positionals], {
    stdio: "inherit",
    cwd: PKG_ROOT,
  });

  await new Promise((res) => child.on("close", res));
  process.exit(child.exitCode ?? 0);
}

// ── PID utilities ─────────────────────────────────────────────────

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // EPERM = alive but owned by another user
  }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) {
    cleanPidFile();
    return null;
  }
  if (!isProcessAlive(pid)) {
    cleanPidFile();
    return null;
  }
  return pid;
}

function cleanPidFile() {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Already gone
  }
}

// ── Health check utilities ────────────────────────────────────────

async function healthCheck(host, port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function healthCheckFull(host, port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForTunnelUrl(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await healthCheckFull(host, port);
    if (data?.tunnelUrl) return data.tunnelUrl;
    await sleep(500);
  }
  return null;
}

async function waitForHealth(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheck(host, port)) return true;
    await sleep(500);
  }
  return false;
}

async function waitForExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(250);
  }
  return false;
}

// ── Config utilities ──────────────────────────────────────────────

function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

// ── Diagnostic utilities ──────────────────────────────────────────

async function diagnoseStartFailure() {
  if (!existsSync(LOG_FILE)) return;
  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.split("\n").slice(-20);
    const eaddrinuse = lines.find((l) => l.includes("EADDRINUSE"));
    const eacces = lines.find((l) => l.includes("EACCES"));
    if (eaddrinuse) {
      console.log("\n  Error: Port is already in use.");
      console.log("  Another process may be using the same port.");
    } else if (eacces) {
      console.log("\n  Error: Permission denied.");
      console.log("  Try using a port >= 1024.");
    }
  } catch {
    // Best effort
  }
}

// ── Output / formatting ──────────────────────────────────────────

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Help text ─────────────────────────────────────────────────────

function printHelp() {
  console.log(`
drawlatch v${VERSION}

Usage: drawlatch [command] [options]

Commands:
  start              Start the remote server (background by default)
  stop               Stop the background remote server
  restart            Restart the background remote server
  status             Show server status (PID, port, uptime, health, sessions)
  logs               View and follow remote server logs
  config             Show effective configuration
  generate-keys      Generate Ed25519 + X25519 keypairs

Options:
  -h, --help         Show this help message
  -v, --version      Show version number

Running 'drawlatch' with no arguments shows status (if running) or this help.

Examples:
  drawlatch                            Show status or help
  drawlatch start                      Start remote server in background
  drawlatch start -f                   Start remote server in foreground
  drawlatch start -f --tunnel          Start with a public tunnel for webhooks
  drawlatch start --port 8080          Start on a custom port
  drawlatch status                     Check if server is running
  drawlatch logs -n 100                View last 100 log lines
  drawlatch generate-keys remote       Generate remote server keypair
  drawlatch generate-keys local mybot  Generate local keypair for alias "mybot"
`);
}

function printStartHelp() {
  console.log(`
drawlatch start

Start the drawlatch remote server.

Usage: drawlatch start [options]

Options:
  -f, --foreground   Run in foreground (default when no command given)
  -t, --tunnel       Start a Cloudflare tunnel for webhook ingestion (requires cloudflared)
  --port <number>    Override the configured port
  --host <address>   Override the configured host
  -h, --help         Show this help message

By default, starts the server as a background daemon. The server
process ID is stored in ~/.drawlatch/drawlatch.pid.
`);
}

function printStopHelp() {
  console.log(`
drawlatch stop

Stop the drawlatch remote server.

Usage: drawlatch stop [options]

Options:
  -h, --help   Show this help message

Sends SIGTERM to the server process and waits for graceful shutdown.
Falls back to SIGKILL if the process does not exit within 5 seconds.
`);
}

function printRestartHelp() {
  console.log(`
drawlatch restart

Restart the drawlatch remote server.

Usage: drawlatch restart [options]

Options:
  --port <number>    Override the configured port
  --host <address>   Override the configured host
  -h, --help         Show this help message

Stops the running server (if any) and starts a new instance.
`);
}

function printStatusHelp() {
  console.log(`
drawlatch status

Show server status.

Usage: drawlatch status [options]

Options:
  -h, --help   Show this help message

Displays PID, host, port, uptime, health check result, and
active session count.
`);
}

function printLogsHelp() {
  console.log(`
drawlatch logs

View server logs.

Usage: drawlatch logs [options]

Options:
  -n, --lines <number>  Number of lines to show (default: 50)
  --follow               Follow/tail the log output (default: print and exit)
  -h, --help             Show this help message

Log file: ~/.drawlatch/logs/drawlatch.log
`);
}

function printConfigHelp() {
  console.log(`
drawlatch config

Show effective configuration.

Usage: drawlatch config [options]

Options:
  --path       Print the config file path only
  -h, --help   Show this help message

Reads ~/.drawlatch/remote.config.json and displays the effective
server configuration including callers and connections.
`);
}

function printGenerateKeysHelp() {
  console.log(`
drawlatch generate-keys

Generate Ed25519 + X25519 keypairs for authentication and encryption.

Usage: drawlatch generate-keys <subcommand> [options]

Subcommands:
  local [alias]      Generate MCP proxy (local) keypair
                     Alias defaults to "default" if omitted.
                     Keys are stored in keys/local/<alias>/
  remote             Generate remote server keypair
  --dir <path>       Generate keypair in a custom directory
  show <path>        Show fingerprint of an existing keypair

Keys are saved as PEM files:
  <dir>/signing.pub.pem       Ed25519 public key (safe to share)
  <dir>/signing.key.pem       Ed25519 private key (keep secret!)
  <dir>/exchange.pub.pem      X25519 public key (safe to share)
  <dir>/exchange.key.pem      X25519 private key (keep secret!)
`);
}
