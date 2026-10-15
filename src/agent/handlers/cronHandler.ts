import { AgentCronScheduler } from '../cron/cronScheduler';

export async function handleCronControl(
  control: any,
  scheduler: AgentCronScheduler,
  targetWs: any
): Promise<void> {
  const isOpen = () =>
    targetWs &&
    (targetWs.readyState === 1 || targetWs.readyState === (targetWs.constructor?.OPEN ?? 1));

  const send = (payload: any) => {
    if (isOpen()) {
      targetWs.send(`JSON:${JSON.stringify(payload)}`);
    }
  };

  try {
    if (control.type === 'cron_sync') {
      const jobs = Array.isArray(control.jobs) ? control.jobs : [];
      scheduler.syncJobs(jobs);
      send({
        type: 'cron_sync_res',
        success: true,
        count: jobs.length,
      });
      return;
    }

    if (control.type === 'cron_trigger') {
      const { jobId, requestId } = control;
      try {
        const record = await scheduler.triggerJob(jobId);
        send({
          type: 'cron_trigger_res',
          requestId,
          success: record.status !== 'failed',
          record,
        });
      } catch (err: any) {
        send({
          type: 'cron_trigger_res',
          requestId,
          success: false,
          error: err.message,
        });
      }
      return;
    }

    if (control.type === 'cron_list') {
      const { requestId } = control;
      const summaries = scheduler.getSummaries();
      send({
        type: 'cron_list_res',
        requestId,
        summaries,
      });
      return;
    }

    if (control.type === 'cron_history') {
      const { requestId, jobId, limit } = control;
      const history = scheduler.getExecutionHistory(jobId, limit);
      send({
        type: 'cron_history_res',
        requestId,
        history,
      });
      return;
    }
  } catch (err: any) {
    send({
      type: 'cron_error',
      error: err.message,
    });
  }
}
