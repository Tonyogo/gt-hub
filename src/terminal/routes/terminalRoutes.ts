import { Router } from 'express';
import terminalHostController from '../controllers/terminalHostController';
import terminalFileController from '../controllers/terminalFileController';
import terminalExecController from '../controllers/terminalExecController';
import terminalLogController from '../controllers/terminalLogController';
import adminAuthMiddleware from '../../admin/middlewares/adminAuth';

const router = Router();

router.use(adminAuthMiddleware);

// Host Management
router.get('/hosts', (req, res) => terminalHostController.getHosts(req, res));
router.delete('/hosts/offline', (req, res) => terminalHostController.pruneOfflineHosts(req, res));

// Remote File Management
router.get('/files/list', (req, res) => terminalFileController.listFiles(req, res));
router.get('/files/content', (req, res) => terminalFileController.readFileContent(req, res));
router.post('/files/save', (req, res) => terminalFileController.saveFileContent(req, res));
router.post('/files/mkdir', (req, res) => terminalFileController.createDirectory(req, res));
router.post('/files/rename', (req, res) => terminalFileController.renameFile(req, res));
router.delete('/files/delete', (req, res) => terminalFileController.deleteItem(req, res));
router.get('/files/download', (req, res) => terminalFileController.downloadFile(req, res));
router.post('/files/upload', (req, res) => terminalFileController.uploadFile(req, res));

// Standalone Command Execution
router.post('/exec/:hostId', (req, res) => terminalExecController.startExec(req, res));
router.get('/exec/:hostId/:taskId', (req, res) => terminalExecController.getExecStatus(req, res));
router.post('/exec/:hostId/:taskId/kill', (req, res) => terminalExecController.killExec(req, res));
router.get('/exec/:hostId', (req, res) => terminalExecController.listExec(req, res));

// System Console Logs
router.get('/logs', (req, res) => terminalLogController.getTerminalLogs(req, res));

export default router;
