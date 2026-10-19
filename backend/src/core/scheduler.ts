// Programación de recordatorios (RNF-17).
// Local: la tabla reminders es la fuente de verdad y el worker la sondea.
// AWS:   un horario único de EventBridge Scheduler por recordatorio, con reintentos y DLQ,
//        que deja un mensaje en la cola de eventos de dominio.
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import type { Config } from '../config.js';

export interface Scheduler {
  schedule(reminderId: string, fireAt: Date): Promise<void>;
  cancel(reminderId: string): Promise<void>;
}

export class PollingScheduler implements Scheduler {
  async schedule() {}
  async cancel() {}
}

export class EventBridgeScheduler implements Scheduler {
  private client: SchedulerClient;
  constructor(private cfg: Config) {
    this.client = new SchedulerClient({ region: cfg.aws.region });
  }

  async schedule(reminderId: string, fireAt: Date) {
    const at = fireAt.toISOString().slice(0, 19);
    await this.client.send(
      new CreateScheduleCommand({
        Name: `reminder-${reminderId}`,
        ScheduleExpression: `at(${at})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: this.cfg.scheduler.targetArn,
          RoleArn: this.cfg.scheduler.roleArn,
          Input: JSON.stringify({ 'detail-type': 'ReminderFire', detail: { reminderId } }),
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 300 },
        },
      }),
    );
  }

  async cancel(reminderId: string) {
    await this.client.send(new DeleteScheduleCommand({ Name: `reminder-${reminderId}` })).catch(() => undefined);
  }
}
