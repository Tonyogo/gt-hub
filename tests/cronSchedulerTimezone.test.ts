import path from 'path';
import fs from 'fs';
import os from 'os';
import { AgentCronScheduler } from '../src/agent/cron/cronScheduler';
import { getNextCronTime } from '../src/shared/utils/cronParser';
import { CronJobConfig } from '../src/shared/types/cron';

describe('AgentCronScheduler Timezone Support', () => {
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

  it('preserves timezone property and calculates nextRunTime with timezone in summaries', () => {
    const job: CronJobConfig = {
      id: 'tz-job-shanghai',
      name: 'Shanghai Report',
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      source: 'command',
      command: 'echo "shanghai"',
      concurrency: 'forbid',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    scheduler.syncJobs([job]);

    const summaries = scheduler.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].timezone).toBe('Asia/Shanghai');
    const expectedTime = getNextCronTime('0 9 * * *', undefined, 'Asia/Shanghai').getTime();
    expect(summaries[0].nextRunTime).toBe(expectedTime);
  });

  it('handles default local timezone when timezone is not specified', () => {
    const job: CronJobConfig = {
      id: 'tz-job-local',
      name: 'Local Backup',
      cron: '0 2 * * *',
      source: 'command',
      command: 'echo "local"',
      concurrency: 'forbid',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    scheduler.syncJobs([job]);

    const summaries = scheduler.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].timezone).toBeUndefined();
    const expectedTime = getNextCronTime('0 2 * * *').getTime();
    expect(summaries[0].nextRunTime).toBe(expectedTime);
  });

  it('persists timezone to disk and reloads it accurately', () => {
    const job: CronJobConfig = {
      id: 'tz-job-persist',
      name: 'NY Job',
      cron: '30 14 * * 1-5',
      timezone: 'America/New_York',
      source: 'command',
      command: 'echo "ny"',
      concurrency: 'forbid',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    scheduler.syncJobs([job]);

    // Create a new scheduler instance pointing to the same storage
    const reloadedScheduler = new AgentCronScheduler({
      storageFile: path.join(tempDir, 'cron.json'),
      historyFile: path.join(tempDir, 'history.json'),
      cacheDir: path.join(tempDir, 'cache'),
    });

    const jobs = reloadedScheduler.getJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].timezone).toBe('America/New_York');

    const summaries = reloadedScheduler.getSummaries();
    const expectedTime = getNextCronTime('30 14 * * 1-5', undefined, 'America/New_York').getTime();
    expect(summaries[0].nextRunTime).toBe(expectedTime);
  });
});
