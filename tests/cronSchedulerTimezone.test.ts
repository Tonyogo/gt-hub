import path from 'path';
import fs from 'fs';
import os from 'os';
import { AgentCronScheduler } from '../src/agent/cron/cronScheduler';
import { getNextCronTime } from '../src/shared/utils/cronParser';
import { CronJobConfig } from '../src/shared/types/cron';

describe('AgentCronScheduler Server Timezone Sync & Offline Retention', () => {
  let tempDir: string;
  let scheduler: AgentCronScheduler;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-agent-cron-tz-test-'));
    scheduler = new AgentCronScheduler({
      storageFile: path.join(tempDir, 'cron.json'),
      historyFile: path.join(tempDir, 'history.json'),
      cacheDir: path.join(tempDir, 'cache'),
    });
  });

  afterEach(() => {
    scheduler.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('stores serverTimezone on syncJobs and calculates nextRunTime using server timezone', () => {
    const job: CronJobConfig = {
      id: 'tz-job-shanghai',
      name: 'Shanghai Report',
      cron: '0 9 * * *',
      source: 'command',
      command: 'echo "shanghai"',
      concurrency: 'forbid',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    scheduler.syncJobs([job], 'Asia/Shanghai');

    expect(scheduler.serverTimezone).toBe('Asia/Shanghai');
    const summaries = scheduler.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].timezone).toBe('Asia/Shanghai');
    const expectedTime = getNextCronTime('0 9 * * *', undefined, 'Asia/Shanghai').getTime();
    expect(summaries[0].nextRunTime).toBe(expectedTime);
  });

  it('updates serverTimezone when new sync arrives with different server timezone', () => {
    const job: CronJobConfig = {
      id: 'tz-job-london',
      name: 'London Job',
      cron: '0 2 * * *',
      source: 'command',
      command: 'echo "london"',
      concurrency: 'forbid',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    scheduler.syncJobs([job], 'Europe/London');

    expect(scheduler.serverTimezone).toBe('Europe/London');
    const summaries = scheduler.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].timezone).toBe('Europe/London');
    const expectedTime = getNextCronTime('0 2 * * *', undefined, 'Europe/London').getTime();
    expect(summaries[0].nextRunTime).toBe(expectedTime);
  });

  it('persists serverTimezone to disk and reloads it accurately on offline start/restart', () => {
    const job: CronJobConfig = {
      id: 'tz-job-persist',
      name: 'NY Job',
      cron: '30 14 * * 1-5',
      source: 'command',
      command: 'echo "ny"',
      concurrency: 'forbid',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    scheduler.syncJobs([job], 'America/New_York');

    // Verify raw disk file contains serverTimezone
    const storagePath = path.join(tempDir, 'cron.json');
    const rawDisk = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
    expect(rawDisk.serverTimezone).toBe('America/New_York');
    expect(Array.isArray(rawDisk.jobs)).toBe(true);
    expect(rawDisk.jobs.length).toBe(1);

    // Create a new scheduler instance pointing to the same storage file (offline simulation)
    const reloadedScheduler = new AgentCronScheduler({
      storageFile: storagePath,
      historyFile: path.join(tempDir, 'history.json'),
      cacheDir: path.join(tempDir, 'cache'),
    });

    expect(reloadedScheduler.serverTimezone).toBe('America/New_York');
    const jobs = reloadedScheduler.getJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].timezone).toBe('America/New_York');

    const summaries = reloadedScheduler.getSummaries();
    const expectedTime = getNextCronTime('30 14 * * 1-5', undefined, 'America/New_York').getTime();
    expect(summaries[0].nextRunTime).toBe(expectedTime);
    reloadedScheduler.stop();
  });

  it('updates serverTimezone and clears stale jobs when synced with empty jobs array', () => {
    // 1. Initial job
    const job: CronJobConfig = {
      id: 'tz-job-stale',
      name: 'Old Job',
      cron: '0 10 * * *',
      source: 'command',
      command: 'echo "old"',
      concurrency: 'forbid',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    scheduler.syncJobs([job], 'Asia/Tokyo');
    expect(scheduler.serverTimezone).toBe('Asia/Tokyo');
    expect(scheduler.getJobs().length).toBe(1);

    // 2. Hub syncs empty jobs with new timezone
    scheduler.syncJobs([], 'Europe/Berlin');
    expect(scheduler.serverTimezone).toBe('Europe/Berlin');
    expect(scheduler.getJobs().length).toBe(0);

    // 3. Verify disk persistence
    const storagePath = path.join(tempDir, 'cron.json');
    const rawDisk = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
    expect(rawDisk.serverTimezone).toBe('Europe/Berlin');
    expect(rawDisk.jobs).toEqual([]);

    // 4. Reload offline
    const reloaded = new AgentCronScheduler({
      storageFile: storagePath,
      historyFile: path.join(tempDir, 'history.json'),
      cacheDir: path.join(tempDir, 'cache'),
    });
    expect(reloaded.serverTimezone).toBe('Europe/Berlin');
    expect(reloaded.getJobs().length).toBe(0);
    reloaded.stop();
  });
});
