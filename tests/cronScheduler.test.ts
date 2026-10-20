import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentCronScheduler } from '../src/agent/cron/cronScheduler';
import { CronJobConfig, CronExecutionRecord, CronJobSummary } from '../src/shared/types/cron';
import { taskManager } from '../src/agent/tasks/taskManager';

describe('AgentCronScheduler', () => {
  let tempDir: string;
  let storageFile: string;
  let cacheDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cron-test-'));
    storageFile = path.join(tempDir, 'cron.json');
    cacheDir = path.join(tempDir, 'scripts-cache');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('persists jobs to local storage file and reloads them', () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    expect(scheduler.getJobs()).toEqual([]);

    const jobs: CronJobConfig[] = [
      {
        id: 'job-1',
        name: 'test-job',
        cron: '*/5 * * * *',
        source: 'command',
        command: 'echo "hello"',
        concurrency: 'forbid',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    scheduler.syncJobs(jobs);
    expect(scheduler.getJobs().length).toBe(1);
    expect(fs.existsSync(storageFile)).toBe(true);

    // New instance loads from existing file
    const scheduler2 = new AgentCronScheduler({ storageFile, cacheDir });
    expect(scheduler2.getJobs().length).toBe(1);
    expect(scheduler2.getJobs()[0].id).toBe('job-1');
    scheduler.stop();
    scheduler2.stop();
  });

  it('returns summaries with computed nextRunTime', () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    const now = Date.now();
    scheduler.syncJobs([
      {
        id: 'active-job',
        name: 'Active',
        cron: '*/5 * * * *',
        source: 'command',
        command: 'echo 1',
        concurrency: 'forbid',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'paused-job',
        name: 'Paused',
        cron: '*/5 * * * *',
        source: 'command',
        command: 'echo 2',
        concurrency: 'forbid',
        status: 'paused',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const summaries = scheduler.getSummaries();
    expect(summaries.length).toBe(2);

    const active = summaries.find((s: CronJobSummary) => s.id === 'active-job')!;
    const paused = summaries.find((s: CronJobSummary) => s.id === 'paused-job')!;

    expect(active.nextRunTime).toBeGreaterThan(Date.now());
    expect(paused.nextRunTime).toBeNull();
    scheduler.stop();
  });

  it('handles execution and reports completion', async () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    const reported: CronExecutionRecord[] = [];
    scheduler.onReport((record: CronExecutionRecord) => {
      reported.push(record);
    });

    scheduler.syncJobs([
      {
        id: 'exec-job',
        name: 'Echo Test',
        cron: '* * * * *',
        source: 'command',
        command: 'echo "cron execution success"',
        concurrency: 'forbid',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const record = await scheduler.triggerJob('exec-job');
    expect(record.status).toBe('completed');
    expect(record.exitCode).toBe(0);
    expect(record.jobId).toBe('exec-job');
    expect(reported.length).toBeGreaterThanOrEqual(1);

    const history = scheduler.getExecutionHistory('exec-job');
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].status).toBe('completed');
    scheduler.stop();
  });

  it('prevents overlapping runs when concurrency is forbid', async () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    const reported: CronExecutionRecord[] = [];
    scheduler.onReport((record: CronExecutionRecord) => reported.push(record));

    scheduler.syncJobs([
      {
        id: 'long-job',
        name: 'Long Running',
        cron: '* * * * *',
        source: 'command',
        command: 'sleep 3',
        concurrency: 'forbid',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    // Start first run asynchronously
    const p1 = scheduler.triggerJob('long-job');

    // Give it a small moment to spawn process in taskManager
    await new Promise((r) => setTimeout(r, 100));

    // Try triggering again while first is running
    const r2 = await scheduler.triggerJob('long-job');
    expect(r2.status).toBe('skipped');
    expect(r2.error).toContain('is still running');

    // Wait for first to complete or kill it
    const r1 = await p1;
    expect(r1.status).toBe('completed');

    scheduler.stop();
  });

  it('supports Hub hosted script caching and execution', async () => {
    const mockHubScripts: Record<string, string> = {
      'custom-script.sh': '#!/bin/sh\necho "hub script executed: $1"\n',
    };

    const scheduler = new AgentCronScheduler({
      storageFile,
      cacheDir,
      getScriptContent: async (name: string) => {
        if (mockHubScripts[name]) {
          return mockHubScripts[name];
        }
        throw new Error(`Script ${name} not found on hub`);
      },
    });

    scheduler.syncJobs([
      {
        id: 'script-job',
        name: 'Hub Script',
        cron: '* * * * *',
        source: 'hub',
        scriptName: 'custom-script.sh',
        scriptArgs: ['hello-arg'],
        concurrency: 'forbid',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const record = await scheduler.triggerJob('script-job');
    expect(record.status).toBe('completed');
    expect(record.exitCode).toBe(0);

    // Verify script cached on disk
    const cachedFile = path.join(cacheDir, 'custom-script.sh');
    expect(fs.existsSync(cachedFile)).toBe(true);

    // Update script on Hub and verify Agent updates local cache on next run
    mockHubScripts['custom-script.sh'] = '#!/bin/sh\necho "updated hub script v2: $1"\n';
    const record2 = await scheduler.triggerJob('script-job');
    expect(record2.status).toBe('completed');
    expect(fs.readFileSync(cachedFile, 'utf-8')).toContain('updated hub script v2');

    // Reject path traversal scriptName
    scheduler.syncJobs([
      {
        id: 'traversal-job',
        name: 'Traversal Script',
        cron: '* * * * *',
        source: 'hub',
        scriptName: '../../evil.sh',
        concurrency: 'forbid',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const traversalRecord = await scheduler.triggerJob('traversal-job');
    expect(traversalRecord.status).toBe('failed');
    expect(traversalRecord.error).toContain('Invalid script name');

    scheduler.stop();
  });
});
