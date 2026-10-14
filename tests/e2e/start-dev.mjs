#!/usr/bin/env node
// Test-only launcher for the browser acceptance suite. It starts the fixture
// services (a local Access JWKS endpoint, a scripted model service, and a fake
// MCP server), builds the application, and serves the production preview so
// that Playwright can own the whole lifetime through its `webServer` option.
//
// The Solid client-mode shell only exists after a build (dev mode deliberately
// serves no index.html), so the acceptance suite runs the real built Worker
// through `vite preview`. The production authentication path is unchanged: the
// browser sends a real signed Access assertion as the `CF_Authorization`
// cookie, and the Worker verifies it against the local JWKS exactly as it would
// verify Cloudflare Access. See tests/e2e/fixture/access.ts.
//
// The model fixture is driven by directives in the last user message:
//   [[slow:3000]]  hold the response open (a live run to reconnect to)
//   [[tool]]       call the first available tool once, then summarise the result
//   [[error]]      fail the model request
// Everything else answers with deterministic text.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const stateDir = join(here, ".state");

// A fresh state directory keeps each run isolated from previous Durable Object
// storage.
rmSync(stateDir, { recursive: true, force: true });
rmSync(join(root, ".e2e-state"), { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

// Ephemeral signing key: nothing is committed and nothing is reused between
// runs.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "mi-e2e", alg: "RS256", use: "sig" };
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
writeFileSync(join(stateDir, "access-key.json"), JSON.stringify({ privatePem, jwk }));

const accessPort = Number(process.env.MI_E2E_ACCESS_PORT ?? 8899);
const accessIssuer = `http://127.0.0.1:${accessPort}`;
const modelPort = Number(process.env.MI_E2E_MODEL_PORT ?? 8898);
const mcpPort = Number(process.env.MI_E2E_MCP_PORT ?? 8897);

// --- Access JWKS fixture -----------------------------------------------------
const jwksServer = createServer((request, response) => {
  if (request.url && request.url.startsWith("/cdn-cgi/access/certs")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  response.writeHead(404);
  response.end();
});

// --- Scripted model fixture --------------------------------------------------
function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chatChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function modelReply(messages, tools) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  const hasToolResult = messages.some((message) => message.role === "tool");
  const slow = /\[\[slow:(\d+)\]\]/.exec(text);
  const wantsTool = text.includes("[[tool]]");
  const wantsError = text.includes("[[error]]");

  if (wantsError) return { kind: "error" };
  if (slow) return { kind: "slow", delayMs: Number(slow[1]), text: `Reply: ${text}` };
  if (wantsTool && !hasToolResult && tools.length > 0) {
    // Prefer the fixture connector tool; application tools may be listed too.
    const tool = tools.find((entry) => entry.function?.name?.endsWith("__echo")) ?? tools[0];
    return { kind: "tool", name: tool.function.name, arguments: { text: "hello from tool" } };
  }
  if (hasToolResult) {
    const toolMessage = [...messages].reverse().find((message) => message.role === "tool");
    const result = typeof toolMessage?.content === "string" ? toolMessage.content : "";
    return { kind: "text", text: `Tool said: ${result}` };
  }
  return { kind: "text", text: `Reply: ${text}` };
}

const modelServer = createServer((request, response) => {
  if (!request.url || !request.url.startsWith("/v1/chat/completions")) {
    response.writeHead(404);
    response.end();
    return;
  }
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* treated as empty */
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const reply = modelReply(messages, tools);

    if (reply.kind === "error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture model failure" } }));
      return;
    }

    if (reply.kind === "slow") {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (reply.kind === "tool") {
      sse(
        response,
        chatChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_fixture_1",
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
            },
          ],
        }),
      );
      sse(response, chatChunk({}, "tool_calls"));
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    const text = reply.text;
    for (const piece of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
      if (piece) sse(response, chatChunk({ content: piece }));
    }
    sse(response, chatChunk({}, "stop"));
    sse(response, {
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

// --- Fake MCP server ---------------------------------------------------------
const MCP_TOOLS = [
  {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "fail",
    description: "Always fails",
    inputSchema: { type: "object", properties: {} },
  },
];

const mcpServer = createServer((request, response) => {
  if (request.method === "DELETE") {
    response.writeHead(200, { "mcp-session-id": "fixture-session" });
    response.end();
    return;
  }
  if (!request.url || !request.url.startsWith("/mcp")) {
    response.writeHead(404);
    response.end();
    return;
  }
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    let message = {};
    try {
      message = JSON.parse(raw);
    } catch {
      /* ignored */
    }
    const headers = { "content-type": "application/json", "mcp-session-id": "fixture-session" };
    if (message.method === "initialize") {
      response.writeHead(200, headers);
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture-mcp", version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202, headers);
      response.end();
      return;
    }
    if (message.method === "tools/list") {
      response.writeHead(200, headers);
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: MCP_TOOLS } }));
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const arguments_ = message.params?.arguments ?? {};
      const result =
        name === "fail"
          ? { content: [{ type: "text", text: "fixture tool failed" }], isError: true }
          : { content: [{ type: "text", text: `echo: ${arguments_.text ?? ""}` }], isError: false };
      response.writeHead(200, headers);
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      return;
    }
    response.writeHead(200, headers);
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  });
});

await Promise.all([
  new Promise((resolve) => jwksServer.listen(accessPort, "127.0.0.1", resolve)),
  new Promise((resolve) => modelServer.listen(modelPort, "127.0.0.1", resolve)),
  new Promise((resolve) => mcpServer.listen(mcpPort, "127.0.0.1", resolve)),
]);

const env = {
  ...process.env,
  NODE_ENV: "production",
  MI_E2E: "1",
  MI_E2E_ACCESS_ISSUER: accessIssuer,
  MI_E2E_ACCESS_AUDIENCE: "mi",
  MI_E2E_MODEL_URL: `http://127.0.0.1:${modelPort}`,
  CLOUDFLARE_VITE_FORCE_LOCAL: "true",
};

const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");

if (process.env.MI_E2E_SKIP_BUILD !== "1") {
  const build = spawnSync(process.execPath, [viteBin, "build"], { cwd: root, stdio: "inherit", env });
  if (build.status !== 0) {
    jwksServer.close();
    modelServer.close();
    mcpServer.close();
    process.exit(build.status ?? 1);
  }
}

const vite = spawn(
  process.execPath,
  [viteBin, "preview", "--port", "3000", "--host", "127.0.0.1", "--strictPort"],
  { cwd: root, stdio: "inherit", env },
);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    vite.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  } catch {
    /* already gone */
  }
  jwksServer.close();
  modelServer.close();
  mcpServer.close();
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
vite.on("exit", (code) => {
  jwksServer.close();
  modelServer.close();
  mcpServer.close();
  process.exit(code ?? 0);
});
