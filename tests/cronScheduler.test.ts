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

  it('executes a fast job only once even if timer wakes up 150ms before target timestamp', async () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    const reported: CronExecutionRecord[] = [];
    scheduler.onReport((r) => reported.push(r));

    const targetTime = Math.ceil((Date.now() + 300) / 1000) * 1000;
    let fakeNow = targetTime - 150;

    // Spy on getNextCronTime behavior by controlling Date.now around the boundary
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    try {
      scheduler.syncJobs([
        {
          id: 'fast-date-job',
          name: 'test',
          cron: '* * * * *',
          source: 'command',
          command: 'date',
          concurrency: 'forbid',
          status: 'active',
          createdAt: fakeNow,
          updatedAt: fakeNow,
        },
      ]);

      // Simulate scheduled execution at targetTime while clock is still 100ms early (targetTime - 100)
      await (scheduler as any).executeJob('fast-date-job', 'scheduled', targetTime);
      (scheduler as any).lastScheduledTriggerTime?.set('fast-date-job', targetTime);

      // Even if clock is still targetTime - 80ms when scheduleJob runs, nextRunTime must be strictly > targetTime
      fakeNow = targetTime - 80;
      const summaries = scheduler.getSummaries();
      expect(summaries[0].nextRunTime).toBeGreaterThan(targetTime);

      // Attempting a second scheduled execution with the same targetTime must be skipped/ignored
      const dup = await (scheduler as any).executeJob('fast-date-job', 'scheduled', targetTime);
      expect(dup.status).toBe('skipped');
      expect(reported.length).toBe(1);

      // Manual trigger is not constrained by lastScheduledTriggerTime and executes
      const manual = await scheduler.triggerJob('fast-date-job');
      expect(manual.status).toBe('completed');
      expect(reported.length).toBe(2);
    } finally {
      dateNowSpy.mockRestore();
      scheduler.stop();
    }
  });

  it('preserves lastScheduledTriggerTime on syncJobs unless cron expression changes', () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    const now = Date.now();
    scheduler.syncJobs([
      {
        id: 'job-a',
        name: 'Job A',
        cron: '*/5 * * * *',
        source: 'command',
        command: 'echo a',
        concurrency: 'forbid',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'job-b',
        name: 'Job B',
        cron: '*/10 * * * *',
        source: 'command',
        command: 'echo b',
        concurrency: 'forbid',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const targetTime = 1762344000000;
    (scheduler as any).lastScheduledTriggerTime.set('job-a', targetTime);
    (scheduler as any).lastScheduledTriggerTime.set('job-b', targetTime);

    // Sync with same cron for job-a, modified cron for job-b
    scheduler.syncJobs([
      {
        id: 'job-a',
        name: 'Job A',
        cron: '*/5 * * * *',
        source: 'command',
        command: 'echo a',
        concurrency: 'forbid',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'job-b',
        name: 'Job B',
        cron: '*/15 * * * *', // changed cron!
        source: 'command',
        command: 'echo b',
        concurrency: 'forbid',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    expect((scheduler as any).lastScheduledTriggerTime.get('job-a')).toBe(targetTime);
    expect((scheduler as any).lastScheduledTriggerTime.has('job-b')).toBe(false);

    // Sync without job-a removes it
    scheduler.syncJobs([]);
    expect((scheduler as any).lastScheduledTriggerTime.has('job-a')).toBe(false);

    scheduler.stop();
  });

  it('restores lastScheduledTriggerTime from history on disk upon initialization', () => {
    const historyFile = path.join(path.dirname(storageFile), 'schedule', 'history.json');
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    const fakeHistory: Partial<CronExecutionRecord>[] = [
      {
        executionId: 'exec-1',
        jobId: 'restored-job',
        triggerTime: 1762344000000,
        status: 'completed',
      },
      {
        executionId: 'exec-2',
        jobId: 'restored-job',
        triggerTime: 1762344060000, // newer trigger time
        status: 'completed',
      },
    ];
    fs.writeFileSync(historyFile, JSON.stringify(fakeHistory), 'utf-8');

    const scheduler = new AgentCronScheduler({ storageFile, historyFile, cacheDir });
    expect((scheduler as any).lastScheduledTriggerTime.get('restored-job')).toBe(1762344060000);
    scheduler.stop();
  });

  it('reschedules timer when wakeup is earlier than target timestamp', async () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    const executeSpy = jest.spyOn(scheduler as any, 'executeJob').mockResolvedValue({ status: 'completed' } as any);
    const scheduleSpy = jest.spyOn(scheduler as any, 'scheduleJob');

    const baseTime = 1762344000000;
    let fakeNow = baseTime;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    try {
      scheduler.syncJobs([
        {
          id: 'early-job',
          name: 'Early Job',
          cron: '* * * * *',
          source: 'command',
          command: 'echo 1',
          concurrency: 'forbid',
          status: 'active',
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ]);

      scheduler.start();

      // Grab the active timer callback
      const timer = (scheduler as any).activeTimers.get('early-job');
      expect(timer).toBeDefined();

      // Now simulate waking up 150ms before target time (baseTime + 60000)
      const targetTime = baseTime + 60000;
      fakeNow = targetTime - 150;

      scheduleSpy.mockClear();

      // Invoke the timer callback directly
      if (typeof (timer as any)._onTimeout === 'function') {
        await (timer as any)._onTimeout();
      }

      // executeJob must NOT have been called because fakeNow < targetTime
      expect(executeSpy).not.toHaveBeenCalled();
      // scheduleJob must have been called to reschedule for remaining ms
      expect(scheduleSpy).toHaveBeenCalledWith('early-job');
    } finally {
      dateSpy.mockRestore();
      scheduler.stop();
    }
  });
});
