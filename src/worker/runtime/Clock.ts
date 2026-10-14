// Injectable time source (PLAN.md -> Tests).

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FixedClock implements Clock {
  constructor(private value: number) {}
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
  set(value: number): void {
    this.value = value;
  }
}

export interface IdGenerator {
  next(prefix?: string): string;
}

export const cryptoIdGenerator: IdGenerator = {
  next: (prefix = "id") => `${prefix}_${crypto.randomUUID()}`,
};

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;
  constructor(private readonly prefix = "id") {}
  next(prefix = this.prefix): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}
