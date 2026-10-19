import http from 'http';
import app from './app';
import config from './config/default';
import logger from '../utils/logger';
import { setupTerminalWebSocket } from '../terminal/routes/terminalWs';
import { validateSecurityConfig } from './config/securityValidator';

const server = http.createServer(app);
const wss = setupTerminalWebSocket(server);

let isShuttingDown = false;

export async function gracefulShutdown(signal = 'SIGTERM', timeoutMs = 5000): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`[Shutdown] Received ${signal}. Starting graceful shutdown...`);

  // 1. Close WebSocket clients with 1001 Going Away
  try {
    if (typeof (wss as any).closeAllClients === 'function') {
      (wss as any).closeAllClients(1001, 'Server shutting down');
    }
  } catch (err: any) {
    logger.warn(`[Shutdown] Error closing WebSocket clients: ${err.message}`);
  }

  // 2. Stop accepting new HTTP requests and close server
  return new Promise((resolve) => {
    const forceExitTimer = setTimeout(() => {
      logger.warn('[Shutdown] Graceful shutdown timed out. Forcing process exit.');
      if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
      }
      resolve();
    }, timeoutMs);
    forceExitTimer.unref();

    server.close((err) => {
      clearTimeout(forceExitTimer);
      if (err) {
        logger.error(`[Shutdown] Error during server close: ${err.message}`);
      } else {
        logger.info('[Shutdown] HTTP and WebSocket server closed cleanly.');
      }
      if (process.env.NODE_ENV !== 'test') {
        process.exit(0);
      }
      resolve();
    });

    if (typeof (server as any).closeIdleConnections === 'function') {
      (server as any).closeIdleConnections();
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    logger.error(`[UnhandledRejection] Server caught unhandled rejection: ${reason}`);
  });

  process.on('uncaughtException', (err) => {
    logger.error(`[UncaughtException] Server caught uncaught exception: ${err.message}`, { stack: err.stack });
  });

  const handleSignal = (signal: string) => {
    gracefulShutdown(signal).catch((err) => {
      logger.error(`[Shutdown] Unhandled error during shutdown: ${err.message}`);
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  validateSecurityConfig({
    secretKey: String(config.adminSecretKey || ''),
  });

  server.listen(config.port, () => {
    logger.info(`gt-hub server is running on port ${config.port}`);
    logger.info(`[Config] Server timezone configured as: ${config.timeZone}`);
    logger.info(`WebSocket endpoints enabled: /api/terminal/ws, /api/terminal/agent-ws, /api/terminal/exec-ws`);
  });
}

export { server, app, wss };
export default server;
