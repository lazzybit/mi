// Default model gateway factory: the AI Gateway binding transport plus the
// three provider codecs.

import { AiBindingTransport } from "./AiBindingTransport";
import { GatewayModelGateway } from "./GatewayModelGateway";
import { AnthropicMessagesCodec } from "./codecs/AnthropicMessagesCodec";
import { OpenAIChatCodec } from "./codecs/OpenAIChatCodec";
import { OpenAIResponsesCodec } from "./codecs/OpenAIResponsesCodec";
import type { ModelGateway } from "./types";

export function createDefaultModelGateway(env: Env): ModelGateway {
  // Resolve the AI binding lazily: accessing it eagerly requires remote
  // bindings, which the local test runtime does not provide.
  return new GatewayModelGateway(new AiBindingTransport(() => env.AI), [
    new OpenAIResponsesCodec(),
    new OpenAIChatCodec(),
    new AnthropicMessagesCodec(),
  ]);
}

export { AiBindingTransport, GatewayModelGateway };
export { AnthropicMessagesCodec, OpenAIChatCodec, OpenAIResponsesCodec };
