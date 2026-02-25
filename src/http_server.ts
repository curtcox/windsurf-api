import Fastify, { FastifyInstance } from "fastify";
import { Client } from "./client";
import { MessageQueue } from "./queue";

interface PromptRequest {
  text: string;
  images?: Array<{ base64: string; mime?: string }>;
  model?: string;
  mode?: string;
  cascadeId?: string | null;
}

interface ResponseQuery {
  cascadeId?: string;
  messageId?: string;
}

interface ModelsQuery {
  details?: string;
}

interface OpenRouterMessageContentPart {
  type?: string;
  text?: string;
}

interface OpenRouterMessage {
  role?: string;
  content?: string | OpenRouterMessageContentPart[] | null;
}

interface OpenRouterChatCompletionRequest {
  model?: string;
  messages?: OpenRouterMessage[];
  stream?: boolean;
  mode?: string;
  max_tokens?: number;
}

export class HttpServer {
  private server: FastifyInstance | null = null;
  private port: number;
  private queue: MessageQueue;

  constructor(private client: Client, port: number = 47923) {
    this.port = port;
    this.queue = new MessageQueue(client);
  }

  private toOpenRouterModelId(label: string): string {
    return `windsurf/${label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")}`;
  }

  private createOpenRouterError(message: string, type: string = "invalid_request_error") {
    return {
      error: {
        message,
        type,
      },
    };
  }

  private extractMessageContentText(
    content: string | OpenRouterMessageContentPart[] | null | undefined
  ): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .filter((part) => part && (part.type === "text" || part.type === undefined))
      .map((part) => part.text || "")
      .join("\n")
      .trim();
  }

  private messagesToPrompt(messages: OpenRouterMessage[]): string {
    return messages
      .map((msg) => {
        const role = (msg.role || "user").toUpperCase();
        const text = this.extractMessageContentText(msg.content);
        return `${role}:\n${text}`;
      })
      .filter((chunk) => chunk.trim().length > 0)
      .join("\n\n");
  }

  private async resolveRequestedModelLabel(requestedModel?: string): Promise<string | undefined> {
    if (!requestedModel || requestedModel.trim().length === 0) {
      return undefined;
    }

    const models = await this.client.getModels();
    const normalized = requestedModel.trim().toLowerCase();

    const exactLabel = models.find(
      (m) => m.label.trim().toLowerCase() === normalized
    );
    if (exactLabel) {
      return exactLabel.label;
    }

    const byOpenRouterId = models.find(
      (m) => this.toOpenRouterModelId(m.label) === normalized
    );
    if (byOpenRouterId) {
      return byOpenRouterId.label;
    }

    const suffix = normalized.includes("/") ? normalized.split("/").pop() || "" : normalized;
    if (suffix) {
      const bySuffix = models.find(
        (m) => this.toOpenRouterModelId(m.label).split("/")[1] === suffix
      );
      if (bySuffix) {
        return bySuffix.label;
      }
    }

    throw new Error(
      `Model '${requestedModel}' was not found. Call GET /api/v1/models to list supported ids.`
    );
  }

  private async awaitCascadeResponseForMessage(
    cascadeId: string,
    messageId: string,
    timeoutMs: number = 300000,
    pollIntervalMs: number = 1000
  ) {
    const baseline = await this.client.getCascadeResponse(cascadeId);
    const baselineOutputId = baseline.outputId;
    const baselineStepIndex = baseline.stepIndex;
    const baselineResponse = baseline.response;

    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const queueMessage = this.queue.getMessage(messageId);
      if (queueMessage?.status === "error") {
        throw new Error(queueMessage.error || "Message queue reported an unknown error.");
      }

      const current = await this.client.getCascadeResponse(cascadeId);
      const hasResponse = !!current.response;

      if (current.ready && hasResponse) {
        return current;
      }

      if (hasResponse) {
        const outputChanged =
          !!current.outputId && current.outputId !== baselineOutputId;
        const stepChanged =
          current.stepIndex !== null && current.stepIndex !== baselineStepIndex;
        const noBaselineResponse = !baselineOutputId && !baselineResponse;

        if (outputChanged || stepChanged || noBaselineResponse) {
          return current;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for model response.`
    );
  }

  private renderPlaygroundHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Windsurf API Playground</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --text: #18212f;
      --muted: #5c6b80;
      --border: #d8e0eb;
      --accent: #0b6cff;
      --accent-2: #1248a1;
      --danger: #c62828;
      --ok: #1b7f3b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at 20% 0%, #e7f0ff 0%, #f5f7fa 50%, #eef3f8 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: min(920px, 100%);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 16px 40px rgba(16, 43, 82, 0.08);
      padding: 22px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0.2px;
    }
    .sub {
      margin: 0 0 18px;
      color: var(--muted);
      font-size: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 12px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      font-size: 13px;
      font-weight: 700;
      color: #334055;
    }
    select, textarea, button {
      width: 100%;
      border-radius: 10px;
      border: 1px solid var(--border);
      font: inherit;
    }
    select, textarea {
      padding: 10px 12px;
      background: #fff;
      color: var(--text);
    }
    textarea {
      min-height: 150px;
      resize: vertical;
      line-height: 1.4;
    }
    .actions {
      margin-top: 12px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    button {
      padding: 11px 14px;
      border: 0;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover { background: var(--accent-2); }
    button:disabled { opacity: 0.7; cursor: not-allowed; }
    #status {
      font-size: 13px;
      color: var(--muted);
      min-height: 18px;
    }
    #status.error { color: var(--danger); }
    #status.ok { color: var(--ok); }
    .response-wrap { margin-top: 16px; }
    pre {
      margin: 8px 0 0;
      padding: 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #fbfcfe;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 120px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 13px;
      line-height: 1.45;
    }
    @media (max-width: 760px) {
      .grid { grid-template-columns: 1fr; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Windsurf API Playground</h1>
    <p class="sub">Submit a query through an OpenRouter-compatible endpoint and view the assistant response.</p>

    <div class="grid">
      <div>
        <label for="mode">Mode</label>
        <select id="mode">
          <option value="default">default</option>
          <option value="read-only">read-only</option>
          <option value="no-tool">no-tool</option>
          <option value="explore">explore</option>
          <option value="planning">planning</option>
          <option value="auto">auto</option>
        </select>
      </div>
      <div>
        <label for="model">Model</label>
        <select id="model"></select>
      </div>
    </div>

    <label for="query">Query</label>
    <textarea id="query" placeholder="Ask a coding question..."></textarea>

    <div class="actions">
      <button id="submit">Submit</button>
      <button id="refreshModels" type="button">Refresh Models</button>
      <span id="status"></span>
    </div>

    <section class="response-wrap">
      <label for="response">Response</label>
      <pre id="response"></pre>
    </section>
  </main>

  <script>
    const modeEl = document.getElementById("mode");
    const modelEl = document.getElementById("model");
    const queryEl = document.getElementById("query");
    const submitEl = document.getElementById("submit");
    const refreshEl = document.getElementById("refreshModels");
    const statusEl = document.getElementById("status");
    const responseEl = document.getElementById("response");

    function setStatus(text, kind = "") {
      statusEl.textContent = text;
      statusEl.className = kind;
    }

    async function loadModels() {
      setStatus("Loading models...");
      modelEl.innerHTML = "";

      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "(default model)";
      modelEl.appendChild(defaultOpt);

      try {
        const res = await fetch("/models?details=1");
        if (!res.ok) {
          throw new Error("Failed to load models (" + res.status + ")");
        }
        const data = await res.json();
        const models = Array.isArray(data.models) ? data.models : [];
        for (const item of models) {
          const opt = document.createElement("option");
          opt.value = item.label;
          const suffix = item.disabled ? " (disabled)" : "";
          opt.textContent = item.label + suffix;
          if (item.disabled) {
            opt.disabled = true;
          }
          modelEl.appendChild(opt);
        }
        setStatus("Loaded " + models.length + " model(s).", "ok");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      }
    }

    async function submitQuery() {
      const text = queryEl.value.trim();
      if (!text) {
        setStatus("Please enter a query first.", "error");
        return;
      }

      const body = {
        mode: modeEl.value,
        model: modelEl.value || undefined,
        messages: [{ role: "user", content: text }],
      };

      submitEl.disabled = true;
      refreshEl.disabled = true;
      responseEl.textContent = "";
      setStatus("Waiting for model response...");

      try {
        const res = await fetch("/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          const errText = data?.error?.message || JSON.stringify(data);
          throw new Error(errText);
        }

        const content = data?.choices?.[0]?.message?.content ?? "";
        responseEl.textContent = content || "(no response text)";
        setStatus("Completed.", "ok");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), "error");
      } finally {
        submitEl.disabled = false;
        refreshEl.disabled = false;
      }
    }

    submitEl.addEventListener("click", () => { void submitQuery(); });
    refreshEl.addEventListener("click", () => { void loadModels(); });
    void loadModels();
  </script>
</body>
</html>`;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Server already running");
    }

    this.server = Fastify({ logger: false });

    this.server.addHook("onRequest", async (request, reply) => {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      reply.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, HTTP-Referer, X-Title"
      );

      if (request.method === "OPTIONS") {
        reply.status(200).send();
      }
    });

    this.server.get("/", async (request, reply) => {
      return {
        name: "windsurf-api",
        status: "ok",
        endpoints: {
          health: "GET /health",
          playground: "GET /playground",
          models: "GET /models",
          openRouterModels: "GET /api/v1/models",
          openRouterChatCompletions: "POST /api/v1/chat/completions",
          trajectories: "GET /trajectories",
          cascadeStatus: "GET /status?cascadeId=<cascade-id>",
          sendPrompt: "POST /prompt",
          response: "GET /response?cascadeId=<cascade-id> (or ?messageId=<message-id>)",
          queue: "GET /queue",
          queueByMessage: "GET /queue/:messageId",
        },
        promptFlow: [
          "1) POST /prompt",
          "2) Poll GET /response?cascadeId=<cascade-id> until ready=true",
          "3) Read response field for final assistant answer",
        ],
      };
    });

    this.server.get("/health", async (request, reply) => {
      return { status: "ok" };
    });

    this.server.get("/playground", async (request, reply) => {
      reply.type("text/html; charset=utf-8");
      return this.renderPlaygroundHtml();
    });

    this.server.get("/api/v1/models", async (request, reply) => {
      try {
        const models = await this.client.getModels();
        return {
          object: "list",
          data: models.map((m) => ({
            id: this.toOpenRouterModelId(m.label),
            object: "model",
            created: 0,
            owned_by: "windsurf-api",
            name: m.label,
            description: m.betaWarningMessage || "",
            context_length: 0,
            pricing: null,
          })),
        };
      } catch (error) {
        return reply
          .status(500)
          .send(this.createOpenRouterError(
            error instanceof Error ? error.message : String(error),
            "server_error"
          ));
      }
    });

    this.server.post<{ Body: OpenRouterChatCompletionRequest }>(
      "/api/v1/chat/completions",
      async (request, reply) => {
        const body = request.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];

        if (body.stream) {
          return reply
            .status(400)
            .send(this.createOpenRouterError("stream=true is not supported by this endpoint."));
        }

        if (messages.length === 0) {
          return reply
            .status(400)
            .send(this.createOpenRouterError("messages is required and must contain at least one item."));
        }

        const prompt = this.messagesToPrompt(messages);
        if (!prompt.trim()) {
          return reply
            .status(400)
            .send(this.createOpenRouterError("messages did not contain any text content."));
        }

        try {
          const resolvedModelLabel = await this.resolveRequestedModelLabel(body.model);
          const cascadeId = await this.client.startCascade();
          const queued = await this.queue.trySendOrQueue(
            cascadeId,
            prompt,
            undefined,
            resolvedModelLabel,
            body.mode
          );
          const result = await this.awaitCascadeResponseForMessage(cascadeId, queued.messageId);
          const completionText = result.response || "";

          return {
            id: `chatcmpl-${queued.messageId}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model || resolvedModelLabel || "windsurf/default",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: completionText,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
            metadata: {
              cascadeId,
              messageId: queued.messageId,
              queueStatus: queued.status,
              mode: body.mode || null,
              resolvedModel: resolvedModelLabel || null,
            },
          };
        } catch (error) {
          return reply.status(400).send(
            this.createOpenRouterError(
              error instanceof Error ? error.message : String(error)
            )
          );
        }
      }
    );

    this.server.get<{ Querystring: ModelsQuery }>("/models", async (request, reply) => {
      try {
        const details =
          request.query.details === "1" ||
          request.query.details === "true" ||
          request.query.details === "yes";
        const models = await this.client.getModels();

        if (!details) {
          return models.map((m) => m.label);
        }

        return {
          count: models.length,
          labels: models.map((m) => m.label),
          models: models.map((m) => ({
            label: m.label,
            modelUid: m.modelUid || m.modelOrAlias?.modelUid || null,
            modelOrAlias: m.modelOrAlias || null,
            disabled: m.disabled,
            supportsImages: m.supportsImages,
            supportsLegacy: m.supportsLegacy,
            isPremium: m.isPremium,
            isBeta: m.isBeta,
            isRecommended: m.isRecommended,
            pricingType: m.pricingType,
            provider: m.provider,
            creditMultiplier: m.creditMultiplier,
            betaWarningMessage: m.betaWarningMessage || null,
          })),
        };
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.server.get<{ Querystring: { cascadeId: string } }>(
      "/status",
      async (request, reply) => {
        const { cascadeId } = request.query;

        if (!cascadeId) {
          return reply.status(400).send({ error: "cascadeId query parameter is required" });
        }

        try {
          const status = await this.client.getCascadeStatus(cascadeId);
          return {
            cascadeId,
            status,
            statusUrl: `/status?cascadeId=${encodeURIComponent(cascadeId)}`,
            responseUrl: `/response?cascadeId=${encodeURIComponent(cascadeId)}`,
          };
        } catch (error) {
          return reply.status(500).send({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.get<{ Querystring: ResponseQuery }>(
      "/response",
      async (request, reply) => {
        const { cascadeId: queryCascadeId, messageId } = request.query;
        let cascadeId = queryCascadeId;

        if (!cascadeId && messageId) {
          const message = this.queue.getMessage(messageId);
          if (!message) {
            return reply.status(404).send({
              error: "Message not found. Provide cascadeId directly or use a known messageId.",
            });
          }
          cascadeId = message.cascadeId;
        }

        if (!cascadeId) {
          return reply.status(400).send({
            error: "Either cascadeId or messageId query parameter is required",
          });
        }

        try {
          const response = await this.client.getCascadeResponse(cascadeId);
          return {
            cascadeId,
            ...response,
          };
        } catch (error) {
          return reply.status(500).send({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.get("/trajectories", async (request, reply) => {
      try {
        const trajectories = await this.client.getTrajectories();
        const mapped = Object.entries(trajectories).map(([cascadeId, summary]) => {
          // Backward compatibility: some proto versions expose isClaudeCode, newer ones do not.
          const summaryWithOptionalClaude = summary as typeof summary & {
            isClaudeCode?: boolean;
          };

          return {
            cascadeId,
            name: summary.renamedTitle || summary.summary,
            summary: summary.summary,
            stepCount: summary.stepCount,
            status: summary.status,
            errored: summary.errored,
            createdTime: summary.createdTime
              ? new Date(
                  Number(summary.createdTime.seconds) * 1000 +
                    summary.createdTime.nanos / 1000000
                ).toISOString()
              : undefined,
            lastModifiedTime: summary.lastModifiedTime
              ? new Date(
                  Number(summary.lastModifiedTime.seconds) * 1000 +
                    summary.lastModifiedTime.nanos / 1000000
                ).toISOString()
              : undefined,
            isClaudeCode: summaryWithOptionalClaude.isClaudeCode,
          };
        });
        return mapped;
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.server.post<{ Body: PromptRequest }>("/prompt", async (request, reply) => {
      const { text, images, model, mode, cascadeId } = request.body;

      if (!text) {
        return reply.status(400).send({ error: "text is required" });
      }

      try {
        let targetCascadeId = cascadeId;
        if (!targetCascadeId) {
          targetCascadeId = await this.client.startCascade();
          console.log("Created new cascade:", targetCascadeId);
        }

        const result = await this.queue.trySendOrQueue(
          targetCascadeId,
          text,
          images,
          model,
          mode
        );

        const queuePosition =
          result.status === "queued"
            ? this.queue.getQueuePosition(result.messageId, targetCascadeId)
            : undefined;

        return {
          status: result.status,
          messageId: result.messageId,
          cascadeId: targetCascadeId,
          queuePosition,
          statusUrl: `/status?cascadeId=${encodeURIComponent(targetCascadeId)}`,
          responseUrl: `/response?cascadeId=${encodeURIComponent(targetCascadeId)}`,
          messageStatusUrl: `/queue/${encodeURIComponent(result.messageId)}`,
        };
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.server.get<{ Querystring: { cascadeId?: string } }>(
      "/queue",
      async (request, reply) => {
        const { cascadeId } = request.query;
        const queue = this.queue.getQueue(cascadeId);

        return {
          queue: queue.map((msg) => ({
            messageId: msg.id,
            cascadeId: msg.cascadeId,
            status: msg.status,
            timestamp: msg.timestamp.toISOString(),
            error: msg.error,
          })),
          length: queue.length,
          cascadeId: cascadeId || null,
        };
      }
    );

    this.server.get<{ Params: { messageId: string } }>(
      "/queue/:messageId",
      async (request, reply) => {
        const { messageId } = request.params;
        const message = this.queue.getMessage(messageId);

        if (!message) {
          return reply.status(404).send({ error: "Message not found" });
        }

        const queuePosition = this.queue.getQueuePosition(
          messageId,
          message.cascadeId
        );

        return {
          messageId: message.id,
          cascadeId: message.cascadeId,
          status: message.status,
          timestamp: message.timestamp.toISOString(),
          queuePosition: queuePosition > 0 ? queuePosition : undefined,
          error: message.error,
          responseUrl: `/response?cascadeId=${encodeURIComponent(message.cascadeId)}`,
        };
      }
    );

    await this.server.listen({ port: this.port, host: "0.0.0.0" });
    console.log(`HTTP server listening on port ${this.port}`);

    this.queue.startWorker();
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.queue.stopWorker();
      await this.server.close();
      this.server = null;
      console.log("HTTP server stopped");
    }
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }
}
