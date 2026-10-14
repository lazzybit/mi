// Serializes transitions that combine queue changes and alarm scheduling
// (PLAN.md -> Persistence and scheduling). Critical sections contain only local
// storage operations and alarm updates, never network calls.

export class TransitionCoordinator {
  private tail: Promise<unknown> = Promise.resolve();

  exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(
      () => operation(),
      () => operation(),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
