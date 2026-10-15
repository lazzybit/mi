// Alarm scheduling (PLAN.md -> Persistence and scheduling). The acceptance
// sequence schedules the wake before committing work, so an alarm that fires
// between the two sees either no work (harmless) or both work and wake.

export interface AlarmStore {
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export class WakeScheduler {
  constructor(private readonly alarms: AlarmStore) {}

  async ensureWakeBy(timestamp: number): Promise<void> {
    const current = await this.alarms.getAlarm();
    if (current === null || current > timestamp) {
      await this.alarms.setAlarm(timestamp);
    }
  }

  async reconcile(nextRunnableAt: number | null): Promise<void> {
    if (nextRunnableAt === null) {
      const current = await this.alarms.getAlarm();
      if (current !== null) await this.alarms.deleteAlarm();
      return;
    }
    // ADR-0002: the reconciled time is the next actionable moment, so a stale
    // earlier wake is replaced, not just shortened.
    const current = await this.alarms.getAlarm();
    if (current === null || current !== nextRunnableAt) {
      await this.alarms.setAlarm(nextRunnableAt);
    }
  }
}

/** Adapts a Durable Object storage object to the AlarmStore interface. */
export function durableObjectAlarmStore(storage: DurableObjectStorage): AlarmStore {
  return {
    getAlarm: () => storage.getAlarm(),
    setAlarm: (timestamp: number) => storage.setAlarm(timestamp),
    deleteAlarm: () => storage.deleteAlarm(),
  };
}
