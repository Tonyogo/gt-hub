import { McpBackendAdapter, McpHostEntry } from '../../shared/mcp/types';
import { terminalHostManager } from '../services/terminalHostManager';
import { terminalExecService } from '../services/terminalExecService';
import { terminalFileService } from '../services/terminalFileService';
import { terminalCronService } from '../services/terminalCronService';

export class DirectServiceAdapter implements McpBackendAdapter {
  public async listNodes(): Promise<McpHostEntry[]> {
    const hosts = terminalHostManager.getHosts();
    return hosts.map((h) => ({
      id: h.id,
      name: h.name,
      hostname: h.hostname,
      ip: h.ip,
      platform: h.platform,
      status: h.status,
      online: h.status === 'online',
      lastSeen: h.lastSeen,
      type: h.type,
      version: h.version,
    }));
  }

  public async startExec(
    hostId: string,
    opts: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
      waitMs?: number;
      env?: Record<string, string>;
      stdin?: string;
    }
  ): Promise<any> {
    return terminalExecService.startExecution(hostId, opts);
  }

  public async getExecStatus(hostId: string, taskId: string, offset?: number): Promise<any> {
    return terminalExecService.getExecutionStatus(hostId, taskId, offset ?? 0);
  }

  public async killExec(hostId: string, taskId: string, signal?: string): Promise<any> {
    return terminalExecService.killExecution(hostId, taskId, signal ?? 'SIGTERM');
  }

  public async listExec(hostId: string, limit?: number): Promise<any> {
    return terminalExecService.listExecutions(hostId, limit ?? 20);
  }

  public async listFiles(hostId: string, targetPath?: string): Promise<any> {
    return terminalFileService.listFiles(hostId, targetPath);
  }

  public async readFileContent(hostId: string, targetPath: string): Promise<any> {
    return terminalFileService.readFileContent(hostId, targetPath);
  }

  public async saveFileContent(hostId: string, targetPath: string, content: string): Promise<any> {
    return terminalFileService.saveFileContent(hostId, targetPath, content);
  }

  public async createDirectory(hostId: string, parentPath: string, dirName: string): Promise<any> {
    return terminalFileService.createDirectory(hostId, parentPath, dirName);
  }

  public async deleteItem(hostId: string, targetPath: string): Promise<any> {
    return terminalFileService.deleteItem(hostId, targetPath);
  }

  public async renameFile(hostId: string, oldPath: string, newPath: string): Promise<any> {
    return terminalFileService.renameFile(hostId, oldPath, newPath);
  }

  public async listCronJobs(hostId: string): Promise<any> {
    const jobs = await terminalCronService.getJobs(hostId);
    return { success: true, data: jobs };
  }

  public async addCronJob(hostId: string, body: Record<string, any>): Promise<any> {
    const job = await terminalCronService.addJob(hostId, body);
    return { success: true, data: job };
  }

  public async updateCronJob(hostId: string, jobId: string, body: Record<string, any>): Promise<any> {
    const job = await terminalCronService.updateJob(hostId, jobId, body);
    return { success: true, data: job };
  }

  public async deleteCronJob(hostId: string, jobId: string): Promise<any> {
    const success = await terminalCronService.removeJob(hostId, jobId);
    return { success };
  }

  public async triggerCronJob(hostId: string, jobId: string): Promise<any> {
    const success = await terminalCronService.triggerJob(hostId, jobId);
    return { success };
  }

  public async getCronJobLogs(hostId: string, jobId: string, offset?: number): Promise<any> {
    return terminalCronService.getJobLogs(hostId, jobId, offset ?? 0);
  }
}

export const mcpDirectAdapter = new DirectServiceAdapter();
export default mcpDirectAdapter;
