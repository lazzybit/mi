import { AppError, type ApiError } from "../../shared/domain";
import { OwnerRpcBase } from "./OwnerRpc";

/** Production transport: a fetch envelope to the owner Durable Object. */
export class OwnerRpcClient extends OwnerRpcBase {
  constructor(
    private readonly stub: DurableObjectStub,
    private readonly headers: Record<string, string> = {},
  ) {
    super();
  }

  protected async call<T>(method: string, args: unknown[]): Promise<T> {
    const response = await this.stub.fetch("https://owner.internal/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify({ method, args }),
    });
    let payload: { value?: T; error?: ApiError };
    try {
      payload = (await response.json()) as { value?: T; error?: ApiError };
    } catch {
      throw new AppError("INVALID_INPUT", `owner RPC returned ${response.status}`);
    }
    if (payload.error) {
      throw new AppError(payload.error.code, payload.error.message, payload.error.retryable);
    }
    if (!response.ok) {
      throw new AppError("INVALID_INPUT", `owner RPC returned ${response.status}`);
    }
    return payload.value as T;
  }
}

/** In-process transport used by tests and by the owner object itself. */
export class InProcessOwnerRpc extends OwnerRpcBase {
  constructor(private readonly runtime: { dispatch(method: string, args: unknown[]): Promise<unknown> }) {
    super();
  }

  protected call<T>(method: string, args: unknown[]): Promise<T> {
    return this.runtime.dispatch(method, args) as Promise<T>;
  }
}
