import http from 'http';
import app from './app';
import config from '../config/default';
import logger from './utils/logger';
import { setupTerminalWebSocket } from './terminal/routes/terminalWs';

const server = http.createServer(app);
setupTerminalWebSocket(server);

server.listen(config.port, () => {
  logger.info(`gt-hub server is running on port ${config.port}`);
  logger.info(`WebSocket endpoints enabled: /api/terminal/ws, /api/terminal/agent-ws, /api/terminal/exec-ws`);
});
