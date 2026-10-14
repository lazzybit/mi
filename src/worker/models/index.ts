// Default model gateway factory: the AI Gateway binding transport plus the
// three provider codecs.

import { AiBindingTransport } from "./AiBindingTransport";
import { GatewayModelGateway } from "./GatewayModelGateway";
import { HttpGatewayTransport } from "./HttpGatewayTransport";
import { AnthropicMessagesCodec } from "./codecs/AnthropicMessagesCodec";
import { OpenAIChatCodec } from "./codecs/OpenAIChatCodec";
import { OpenAIResponsesCodec } from "./codecs/OpenAIResponsesCodec";
import type { ModelGateway } from "./types";

export function createDefaultModelGateway(env: Env): ModelGateway {
  const codecs = [
    new OpenAIResponsesCodec(),
    new OpenAIChatCodec(),
    new AnthropicMessagesCodec(),
  ];
  // Browser acceptance points the gateway at a local fixture model service.
  // The AI binding is still resolved lazily for production: accessing it
  // eagerly requires remote bindings, which the local test runtime does not
  // provide.
  const fixtureUrl = readFixtureModelUrl(env);
  if (fixtureUrl) {
    return new GatewayModelGateway(new HttpGatewayTransport(fixtureUrl), codecs);
  }
  return new GatewayModelGateway(new AiBindingTransport(() => env.AI), codecs);
}

function readFixtureModelUrl(env: Env): string | undefined {
  const value = (env as unknown as Record<string, unknown>).MI_FIXTURE_MODEL_URL;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export { AiBindingTransport, GatewayModelGateway, HttpGatewayTransport };
export { AnthropicMessagesCodec, OpenAIChatCodec, OpenAIResponsesCodec };
