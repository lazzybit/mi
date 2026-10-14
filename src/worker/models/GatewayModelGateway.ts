// Model gateway that selects exactly one provider codec from the configured
// profile and streams decoded events. There is no automatic provider or model
// fallback (PLAN.md -> Model boundary).

import { AppError, type ModelProtocol } from "../../shared/domain";
import type { ModelEvent, ModelGateway, ModelRequest, ProviderCodec, GatewayTransport } from "./types";

export class GatewayModelGateway implements ModelGateway {
  private readonly codecs = new Map<ModelProtocol, ProviderCodec>();

  constructor(
    private readonly transport: GatewayTransport,
    codecs: ProviderCodec[],
  ) {
    for (const codec of codecs) this.codecs.set(codec.protocol, codec);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const codec = this.codecs.get(request.profile.protocol);
    if (!codec) {
      throw new AppError(
        "NOT_CONFIGURED",
        `unsupported model protocol: ${request.profile.protocol}`,
      );
    }
    const gatewayRequest = codec.encode(request);
    const response = await this.transport.send(gatewayRequest, signal);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`model request failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    yield* codec.decode(response, signal);
  }
}
