import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

type PromptRequest = {
  text: string;
  images?: Array<{ base64: string; mime?: string }>;
  model?: string;
  mode?: string;
  cascadeId?: string | null;
};

type PromptResponse = {
  status: string;
  messageId: string;
  cascadeId: string;
  queuePosition?: number;
  statusUrl?: string;
  responseUrl?: string;
  messageStatusUrl?: string;
};

type CascadeResponse = {
  cascadeId: string;
  status: number;
  ready: boolean;
  stepIndex: number | null;
  response: string | null;
  rawResponse: string | null;
  messageId: string | null;
  outputId: string | null;
};

type StatusResponse = {
  cascadeId: string;
  status: number;
  statusUrl: string;
  responseUrl: string;
};

type OpenRouterMessageContentPart = {
  type?: string;
  text?: string;
};

type OpenRouterMessage = {
  role?: string;
  content?: string | OpenRouterMessageContentPart[] | null;
};

type ChatCompletionRequest = {
  model?: string;
  messages: OpenRouterMessage[];
  mode?: string;
};

type QueueState = {
  queue: Array<{
    messageId: string;
    cascadeId: string;
    status: string;
    timestamp: string;
    error?: string;
  }>;
  length: number;
  cascadeId: string | null;
};

type QueueMessage = {
  messageId: string;
  cascadeId: string;
  status: string;
  timestamp: string;
  queuePosition?: number;
  error?: string;
  responseUrl?: string;
};

class WindsurfHttpClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Windsurf HTTP API is not reachable at ${this.baseUrl}. Ensure the Windsurf extension is running with the HTTP server started. (${message})`
      );
    }

    const text = await response.text();
    const json = text ? tryParseJson(text) : null;

    if (!response.ok) {
      const errorMessage = extractErrorMessage(json) || text || `HTTP ${response.status}`;
      throw new Error(errorMessage);
    }

    return (json as T) ?? ({} as T);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.request<PromptResponse>("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }

  async getResponse(cascadeId?: string, messageId?: string): Promise<CascadeResponse> {
    const query = new URLSearchParams();
    if (cascadeId) {
      query.set("cascadeId", cascadeId);
    }
    if (messageId) {
      query.set("messageId", messageId);
    }

    return this.request<CascadeResponse>(`/response?${query.toString()}`);
  }

  async getStatus(cascadeId: string): Promise<StatusResponse> {
    return this.request<StatusResponse>(`/status?cascadeId=${encodeURIComponent(cascadeId)}`);
  }

  async getModels(details: boolean = false): Promise<unknown> {
    return this.request(details ? "/models?details=1" : "/models");
  }

  async getTrajectories(): Promise<unknown[]> {
    return this.request<unknown[]>("/trajectories");
  }

  async getQueue(cascadeId?: string): Promise<QueueState> {
    if (!cascadeId) {
      return this.request<QueueState>("/queue");
    }

    return this.request<QueueState>(`/queue?cascadeId=${encodeURIComponent(cascadeId)}`);
  }

  async getQueueMessage(messageId: string): Promise<QueueMessage> {
    return this.request<QueueMessage>(`/queue/${encodeURIComponent(messageId)}`);
  }

  async chatCompletion(params: ChatCompletionRequest): Promise<unknown> {
    return this.request<unknown>("/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }

  async health(): Promise<unknown> {
    return this.request<unknown>("/health");
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const errorObj = payload as Record<string, unknown>;

  if (typeof errorObj.error === "string") {
    return errorObj.error;
  }

  if (errorObj.error && typeof errorObj.error === "object") {
    const nested = errorObj.error as Record<string, unknown>;
    if (typeof nested.message === "string") {
      return nested.message;
    }
  }

  if (typeof errorObj.message === "string") {
    return errorObj.message;
  }

  return null;
}

function jsonContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function awaitPromptResponse(
  client: WindsurfHttpClient,
  cascadeId: string,
  messageId: string,
  timeoutMs: number = 300_000,
  pollMs: number = 1_000
): Promise<CascadeResponse> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await client.getResponse(cascadeId, messageId);
    if (response.ready) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error("Timed out waiting for Windsurf response after 300 seconds.");
}

function createMcpServer(client: WindsurfHttpClient): McpServer {
  const server = new McpServer({
    name: "windsurf-api",
    version: "0.0.2",
  });

  server.registerTool(
    "windsurf_prompt",
    {
      title: "Windsurf Prompt",
      description: "Send a prompt to Windsurf and optionally wait for the final response.",
      inputSchema: {
        text: z.string().min(1),
        images: z.array(z.object({ base64: z.string(), mime: z.string().optional() })).optional(),
        model: z.string().optional(),
        mode: z
          .enum(["default", "read-only", "no-tool", "explore", "planning", "auto"])
          .optional(),
        cascadeId: z.string().optional(),
        wait: z.boolean().optional().default(true),
      },
    },
    async ({ text, images, model, mode, cascadeId, wait }) => {
      try {
        const queued = await client.prompt({
          text,
          images,
          model,
          mode,
          cascadeId: cascadeId ?? null,
        });

        const shouldWait = wait !== false;
        if (!shouldWait) {
          return jsonContent(queued);
        }

        const response = await awaitPromptResponse(client, queued.cascadeId, queued.messageId);
        return jsonContent({
          queued,
          response,
          responseText: response.response,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "windsurf_chat_completion",
    {
      title: "Windsurf Chat Completion",
      description: "Send an OpenRouter-style chat completion request to Windsurf.",
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.string().optional(),
              content: z.union([
                z.string(),
                z.array(
                  z.object({
                    type: z.string().optional(),
                    text: z.string().optional(),
                  })
                ),
              ]).nullable().optional(),
            })
          )
          .min(1),
        model: z.string().optional(),
        mode: z.string().optional(),
      },
    },
    async ({ messages, model, mode }) => {
      try {
        const completion = await client.chatCompletion({ messages, model, mode });
        return jsonContent(completion);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "windsurf_get_response",
    {
      title: "Windsurf Get Response",
      description: "Fetch the latest cascade response by cascadeId or messageId.",
      inputSchema: {
        cascadeId: z.string().optional(),
        messageId: z.string().optional(),
      },
    },
    async ({ cascadeId, messageId }) => {
      if (!cascadeId && !messageId) {
        return toolError("Either cascadeId or messageId is required.");
      }

      try {
        const response = await client.getResponse(cascadeId, messageId);
        return jsonContent(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "windsurf_get_status",
    {
      title: "Windsurf Get Status",
      description: "Check whether a cascade is idle or busy.",
      inputSchema: {
        cascadeId: z.string().min(1),
      },
    },
    async ({ cascadeId }) => {
      try {
        const status = await client.getStatus(cascadeId);
        return jsonContent(status);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerResource(
    "windsurf_health",
    "windsurf://health",
    {
      title: "Windsurf Health",
      description: "Health check from Windsurf HTTP API.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.health();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerResource(
    "windsurf_models",
    "windsurf://models",
    {
      title: "Windsurf Models",
      description: "List of Windsurf model labels.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.getModels(false);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerResource(
    "windsurf_models_details",
    "windsurf://models/details",
    {
      title: "Windsurf Model Details",
      description: "Detailed Windsurf model metadata.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.getModels(true);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerResource(
    "windsurf_trajectories",
    "windsurf://trajectories",
    {
      title: "Windsurf Trajectories",
      description: "All Windsurf trajectories with metadata.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.getTrajectories();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerResource(
    "windsurf_queue",
    "windsurf://queue",
    {
      title: "Windsurf Queue",
      description: "Current queue state.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.getQueue();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerResource(
    "windsurf_queue_message",
    new ResourceTemplate("windsurf://queue/{messageId}", { list: undefined }),
    {
      title: "Windsurf Queue Message",
      description: "Queue status for a specific message.",
      mimeType: "application/json",
    },
    async (uri, { messageId }) => {
      const data = await client.getQueueMessage(messageId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}

type CliArgs = {
  baseUrl: string;
  transport: "stdio" | "sse";
  port: number;
};

function parseCliArgs(argv: string[]): CliArgs {
  let baseUrl = "http://localhost:47923";
  let transport: "stdio" | "sse" = "stdio";
  let port = 3001;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--url") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --url");
      }
      baseUrl = value;
      i += 1;
      continue;
    }

    if (arg === "--transport") {
      const value = argv[i + 1];
      if (value !== "stdio" && value !== "sse") {
        throw new Error("--transport must be 'stdio' or 'sse'");
      }
      transport = value;
      i += 1;
      continue;
    }

    if (arg === "--port") {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--port must be a positive integer");
      }
      port = parsed;
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { baseUrl, transport, port };
}

function printUsage(): void {
  console.error("Usage: node out/mcp-server.js [--url <http-url>] [--transport stdio|sse] [--port <port>]");
}

async function startSseServer(server: McpServer, port: number): Promise<void> {
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        res.on("close", () => {
          transports.delete(transport.sessionId);
        });
        await server.connect(transport);
        return;
      }

      if (method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sessionId is required" }));
          return;
        }

        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown sessionId" }));
          return;
        }

        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", () => {
      console.error(`Windsurf MCP SSE server listening on http://localhost:${port}/sse`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const { baseUrl, transport, port } = parseCliArgs(process.argv.slice(2));
  const client = new WindsurfHttpClient(baseUrl);
  const server = createMcpServer(client);

  if (transport === "stdio") {
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
    return;
  }

  await startSseServer(server, port);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  printUsage();
  process.exit(1);
});
