'use strict';

/**
 * Entry point for the detached bridge process.
 *
 * The VS Code extension spawns this with the PAT in the environment, then
 * unrefs it, so the bridge keeps serving the terminal CLI after VS Code exits.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const log = require('./log');
const { config } = require('./config');
const { start } = require('./server');

const PID_FILE =
  process.env.BRIDGE_PID_FILE ||
  path.join(os.homedir(), '.ai-bridge', 'bridge.pid');

function writePidFile() {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify(
        { pid: process.pid, port: config.port, startedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch (err) {
    log.warn('could not write pid file: ' + err.message);
  }
}

function clearPidFile() {
  try {
    if (!fs.existsSync(PID_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (saved.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch {
    /* best effort */
  }
}

const server = start();
writePidFile();

function shutdown(signal) {
  log.info('shutting down (' + signal + ')');
  clearPidFile();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', clearPidFile);

process.on('uncaughtException', (err) => {
  log.error('uncaught: ' + (err.stack || err.message));
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection: ' + (err?.stack || err));
});
