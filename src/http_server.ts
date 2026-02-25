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

export class HttpServer {
  private server: FastifyInstance | null = null;
  private port: number;
  private queue: MessageQueue;

  constructor(private client: Client, port: number = 47923) {
    this.port = port;
    this.queue = new MessageQueue(client);
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Server already running");
    }

    this.server = Fastify({ logger: false });

    this.server.addHook("onRequest", async (request, reply) => {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type");

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
          models: "GET /models",
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
