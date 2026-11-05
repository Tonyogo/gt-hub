# Fix Duplicate Cron Job Execution on Early Timer Wakeup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplicate cron job executions caused by early `setTimeout` wakeup (`< 1000ms` before target second) combined with fast-completing commands (`< 50ms`, such as `date`) finishing before the target minute boundary.

**Architecture:**
1. Remove the premature 1-second tolerance (`Date.now() < nextDate.getTime() - 1000`) in `AgentCronScheduler.scheduleJob` (`src/agent/cron/cronScheduler.ts`) so any timer waking up before `nextDate.getTime()` reschedules for the remaining milliseconds and never executes before the target timestamp.
2. Advance the `fromDate` baseline passed to `getNextCronTime` in `scheduleJob(jobId, minAfterTime)` using `Math.max(Date.now(), minAfterTime || 0, lastTrigger + 1000)` so rescheduling after an execution always computes a strictly future cron slot.
3. Track `lastScheduledTriggerTime: Map<string, number>` (seeded from `history.json` on startup) to provide idempotency for `(jobId, triggerTime)` across `cron_sync` reschedules while leaving manual `triggerJob` executions unrestricted.

**Tech Stack:** Node.js, TypeScript, Jest.

**Spec:** In-chat approved design (2026-11-05).

## Global Constraints

- Maintain full compatibility with all existing cron test suites (`tests/cronScheduler.test.ts`, `tests/cronSchedulerTimezone.test.ts`, `tests/agentCronIntegration.test.ts`, `tests/cronE2E.test.ts`).
- Manual `triggerJob(jobId)` must still execute immediately regardless of `lastScheduledTriggerTime`.
- Always run targeted Jest tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

- When a timer wakes up 100–300ms before `nextDate.getTime()`, `scheduleJob` must wait until `Date.now() >= nextDate.getTime()` before invoking `executeJob`, and a fast command (`date` / `echo`) finishing in `< 20ms` must execute **exactly once** for that target minute.
- When `scheduleJob` is called after a scheduled execution completes, `getNextCronTime` must be called with a baseline `>= nextDate.getTime() + 1000` so it never returns the same `nextDate` again even if the system clock was adjusted backward by NTP.
- If `syncJobs` is called repeatedly around the trigger boundary (e.g. on WebSocket reconnect), a scheduled `triggerTime` that has already been triggered for the same `(jobId, cron)` must not execute a second time.
- If a user edits a job's `cron` expression in `syncJobs`, `lastScheduledTriggerTime` for that `jobId` should be cleared if the `cron` expression changed.

---

### Task 1: Fix Early Wakeup Tolerance, Baseline Advancement, and Trigger Idempotency in `AgentCronScheduler`

**Files:**
- Modify: `src/agent/cron/cronScheduler.ts:30-90,153-275`
- Modify: `tests/cronScheduler.test.ts`

**Interfaces:**
- Produces:
  - Updated `scheduleJob(jobId: string, minAfterTime?: number): void` in `src/agent/cron/cronScheduler.ts`
  - `lastScheduledTriggerTime: Map<string, number>` tracking in `AgentCronScheduler`

- [x] **Step 1: Write failing tests in `tests/cronScheduler.test.ts`**

Add tests in `tests/cronScheduler.test.ts` that reproduce:
1. Early timer wakeup (150ms before `nextDate`) with a fast command (`date`) executing twice when `Date.now()` is still before `nextDate` on completion.
2. Duplicate scheduled trigger protection for the exact same `triggerTime` (while allowing manual `triggerJob`).

```ts
  it('executes a fast job only once even if timer wakes up 150ms before target timestamp', async () => {
    const scheduler = new AgentCronScheduler({ storageFile, cacheDir });
    const reported: CronExecutionRecord[] = [];
    scheduler.onReport((r) => reported.push(r));

    const targetTime = Math.ceil((Date.now() + 300) / 1000) * 1000;
    const origDateNow = Date.now;
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
    } finally {
      dateNowSpy.mockRestore();
      scheduler.stop();
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cronScheduler.test.ts -t "executes a fast job only once"`
Expected: FAIL (`expect(summaries[0].nextRunTime).toBeGreaterThan(targetTime)` or `expect(dup.status).toBe('skipped')`)

- [x] **Step 3: Implement the three-layer fix in `src/agent/cron/cronScheduler.ts`**

1. Add `private lastScheduledTriggerTime: Map<string, number> = new Map();` to `AgentCronScheduler`.
2. In `loadFromDisk()`, after loading `this.history`, populate `this.lastScheduledTriggerTime` with the maximum `triggerTime` per `jobId`:
   ```ts
   for (const rec of this.history) {
     if (rec && rec.jobId && typeof rec.triggerTime === 'number') {
       const prev = this.lastScheduledTriggerTime.get(rec.jobId) || 0;
       if (rec.triggerTime > prev) {
         this.lastScheduledTriggerTime.set(rec.jobId, rec.triggerTime);
       }
     }
   }
   ```
3. In `syncJobs(jobs: CronJobConfig[], serverTimezone?: string)`:
   - Before `this.jobs.clear()`, save previous cron expressions (`const prevCrons = new Map<string, string>(); for (const [id, j] of this.jobs) prevCrons.set(id, j.cron);`).
   - After populating `this.jobs`, clean up `this.lastScheduledTriggerTime` for removed jobs or jobs whose `cron` expression changed.
4. In `getSummaries()`:
   ```ts
   const lastTrigger = this.lastScheduledTriggerTime.get(job.id) || 0;
   const baseTime = Math.max(Date.now(), lastTrigger > 0 ? lastTrigger + 1000 : 0);
   nextRunTime = getNextCronTime(job.cron, new Date(baseTime), this.serverTimezone).getTime();
   ```
5. In `scheduleJob(jobId: string, minAfterTime?: number)`:
   ```ts
   const now = Date.now();
   const lastTrigger = this.lastScheduledTriggerTime.get(jobId) || 0;
   const baseTime = Math.max(now, minAfterTime || 0, lastTrigger > 0 ? lastTrigger + 1000 : 0);
   let nextDate: Date;
   try {
     nextDate = getNextCronTime(job.cron, new Date(baseTime), this.serverTimezone);
   } catch {
     return;
   }
   const delay = Math.max(0, nextDate.getTime() - now);
   const MAX_TIMEOUT = 2147483647;
   const timeoutDuration = Math.min(delay, MAX_TIMEOUT);

   const timer = setTimeout(async () => {
     this.activeTimers.delete(jobId);
     if (Date.now() < nextDate.getTime()) {
       if (this.started) {
         this.scheduleJob(jobId);
       }
       return;
     }

     try {
       await this.executeJob(jobId, 'scheduled', nextDate.getTime());
     } catch {}

     if (this.started && this.jobs.has(jobId) && this.jobs.get(jobId)!.status === 'active') {
       this.scheduleJob(jobId, nextDate.getTime() + 1000);
     }
   }, timeoutDuration);
   ```
6. In `executeJob(jobId: string, mode: 'scheduled' | 'manual', triggerTime?: number)`:
   - When `mode === 'scheduled'` and `triggerTime !== undefined`:
     - Check `const prevTrigger = this.lastScheduledTriggerTime.get(job.id) || 0;`.
     - If `prevTrigger >= triggerTime`, return a skipped `CronExecutionRecord` without calling `addHistoryRecord` or `emitReport` (silent idempotency guard so duplicate timer wakeups never pollute history or run twice).
     - Otherwise set `this.lastScheduledTriggerTime.set(job.id, triggerTime);` before starting the task.

- [x] **Step 4: Run all cron test suites and full build**

Run: `npm test -- tests/cronScheduler.test.ts tests/cronSchedulerTimezone.test.ts tests/agentCronIntegration.test.ts tests/cronE2E.test.ts && npm run build`
Expected: PASS on all test suites and build succeeds.

- [x] **Step 5: Commit**

```bash
git add src/agent/cron/cronScheduler.ts tests/cronScheduler.test.ts docs/superpowers/plans/2026-11-05-fix-cron-duplicate-execution.md
git commit -m "fix(cron): prevent duplicate job execution on early timer wakeup"
```
