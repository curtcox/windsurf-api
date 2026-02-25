import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { create } from "@bufbuild/protobuf";
import { LanguageServerService } from "./gen/exa.language_server_pb_pb";
import {
  TextOrScopeItemSchema,
  ImageDataSchema,
  MetadataSchema,
  ClientModelConfig,
  ConversationalPlannerMode,
} from "./gen/exa.codeium_common_pb_pb";
import {
  CascadeConfigSchema,
  CascadePlannerConfigSchema,
  CascadeConversationalPlannerConfigSchema,
  CascadeToolConfigSchema,
  RunCommandToolConfigSchema,
  AutoCommandConfigSchema,
  BrainConfigSchema,
  BrainUpdateStrategySchema,
  DynamicBrainUpdateConfigSchema,
  CascadeTrajectorySummary,
  CascadeRunStatus,
  CortexTrajectoryStep,
} from "./gen/exa.cortex_pb_pb";
import { ChatParams } from "./types";

async function detectMimeType(base64: string): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const { fileTypeFromBuffer } = await import("file-type");
  const type = await fileTypeFromBuffer(buffer);
  return type?.mime || "application/octet-stream";
}

export class Client {
  private client: ReturnType<typeof createClient<typeof LanguageServerService>>;

  constructor(private chatParams: ChatParams) {
    const transport = createConnectTransport({
      baseUrl: chatParams.languageServerUrl,
      useBinaryFormat: true,
      interceptors: [
        (next) => async (req) => {
          req.header.set("x-codeium-csrf-token", chatParams.csrfToken);
          req.header.set("accept-language", "en-US");
          return await next(req);
        },
      ],
    });

    this.client = createClient(LanguageServerService, transport);
  }

  private createMetadata() {
    return create(MetadataSchema, {
      apiKey: this.chatParams.apiKey,
      ideName: this.chatParams.ideName,
      ideVersion: this.chatParams.ideVersion,
      extensionName: this.chatParams.extensionName,
      extensionVersion: this.chatParams.extensionVersion,
      locale: this.chatParams.locale,
      os: this.chatParams.osName,
      hardware: this.chatParams.architecture,
    });
  }

  private parsePlannerMode(mode?: string): ConversationalPlannerMode {
    if (!mode) {
      return ConversationalPlannerMode.DEFAULT;
    }

    const normalized = mode.trim().toLowerCase();

    const mapping: Record<string, ConversationalPlannerMode> = {
      default: ConversationalPlannerMode.DEFAULT,
      write: ConversationalPlannerMode.DEFAULT,
      "read-only": ConversationalPlannerMode.READ_ONLY,
      readonly: ConversationalPlannerMode.READ_ONLY,
      read: ConversationalPlannerMode.READ_ONLY,
      "no-tool": ConversationalPlannerMode.NO_TOOL,
      notool: ConversationalPlannerMode.NO_TOOL,
      chat: ConversationalPlannerMode.NO_TOOL,
      explore: ConversationalPlannerMode.EXPLORE,
      planning: ConversationalPlannerMode.PLANNING,
      plan: ConversationalPlannerMode.PLANNING,
      auto: ConversationalPlannerMode.AUTO,
    };

    const plannerMode = mapping[normalized];
    if (plannerMode === undefined) {
      throw new Error(
        `Unsupported mode '${mode}'. Supported values: default, read-only, no-tool, explore, planning, auto`
      );
    }

    return plannerMode;
  }

  async sendMessageDirect(
    text: string,
    cascadeId: string,
    images?: Array<{ base64: string; mime?: string }>,
    modelLabel?: string,
    mode?: string
  ): Promise<void> {
    const metadata = this.createMetadata();
    const plannerMode = this.parsePlannerMode(mode);
    let requestedModelDeprecated: ClientModelConfig["modelOrAlias"] | undefined;
    let requestedModelUid = "";
    let planModelUid = "";

    if (modelLabel) {
      const models = await this.getModels();
      const normalizedLabel = modelLabel.trim().toLowerCase();
      const selectedModel =
        models.find((m) => m.label.trim().toLowerCase() === normalizedLabel) ||
        models.find((m) => m.label === modelLabel);

      if (!selectedModel) {
        const available = models.map((m) => m.label).join(", ");
        throw new Error(
          `Model '${modelLabel}' not found. Available models: ${available}`
        );
      }

      requestedModelUid =
        selectedModel.modelUid || selectedModel.modelOrAlias?.modelUid || "";
      planModelUid = requestedModelUid;

      const candidate = selectedModel.modelOrAlias;
      if (
        candidate &&
        (candidate.modelUid.length > 0 || candidate.alias !== 0 || candidate.model !== 0)
      ) {
        requestedModelDeprecated = candidate;
      }

      if (!requestedModelUid && !requestedModelDeprecated) {
        throw new Error(
          `Model '${modelLabel}' could not be resolved into modelUid or model alias.`
        );
      }
    }

    const cascadeConfig = create(CascadeConfigSchema, {
      plannerConfig: create(CascadePlannerConfigSchema, {
        conversational: create(CascadeConversationalPlannerConfigSchema, {
          plannerMode,
        }),
        toolConfig: create(CascadeToolConfigSchema, {
          runCommand: create(RunCommandToolConfigSchema, {
            autoCommandConfig: create(AutoCommandConfigSchema, {
              autoExecutionPolicy: 3,
            }),
          }),
        }),
        requestedModelDeprecated,
        requestedModelUid,
        planModelUid,
      }),
      brainConfig: create(BrainConfigSchema, {
        enabled: true,
        updateStrategy: create(BrainUpdateStrategySchema, {
          dynamicUpdate: create(DynamicBrainUpdateConfigSchema, {}),
        }),
      }),
    });

    const items = [create(TextOrScopeItemSchema, { text })];

    const imageData = images
      ? await Promise.all(
          images.map(async (img) =>
            create(ImageDataSchema, {
              base64Data: img.base64,
              mimeType: img.mime || (await detectMimeType(img.base64)),
              caption: "",
            })
          )
        )
      : [];

    await this.client.sendUserCascadeMessage({
      cascadeId,
      items,
      images: imageData,
      metadata,
      cascadeConfig,
      recipeIds: [],
      blocking: false,
      additionalSteps: [],
    });

    console.log("Message sent successfully to cascade", cascadeId);
  }

  async startCascade(): Promise<string> {
    const metadata = this.createMetadata();

    const response = await this.client.startCascade({
      metadata,
      source: 0,
      trajectoryType: 0,
    });

    return response.cascadeId;
  }

  private async getCascadeTrajectoryRaw(cascadeId: string) {
    return await this.client.getCascadeTrajectory({
      cascadeId,
    });
  }

  async getCascadeStatus(cascadeId: string): Promise<CascadeRunStatus> {
    const response = await this.getCascadeTrajectoryRaw(cascadeId);

    return response.status;
  }

  private extractLatestPlannerResponse(
    steps: CortexTrajectoryStep[]
  ): {
    stepIndex: number;
    response: string | null;
    rawResponse: string | null;
    messageId: string | null;
    outputId: string | null;
  } | null {
    for (let i = steps.length - 1; i >= 0; i--) {
      const planner = steps[i].plannerResponse;
      if (!planner) {
        continue;
      }

      const responseText = planner.modifiedResponse || planner.response;
      if (!responseText) {
        continue;
      }

      return {
        stepIndex: i,
        response: responseText,
        rawResponse: planner.response || null,
        messageId: planner.messageId || null,
        outputId: planner.outputId || null,
      };
    }

    return null;
  }

  async getCascadeResponse(cascadeId: string): Promise<{
    status: CascadeRunStatus;
    ready: boolean;
    stepIndex: number | null;
    response: string | null;
    rawResponse: string | null;
    messageId: string | null;
    outputId: string | null;
  }> {
    const trajectory = await this.getCascadeTrajectoryRaw(cascadeId);
    const steps = trajectory.trajectory?.steps || [];
    const latest = this.extractLatestPlannerResponse(steps);

    return {
      status: trajectory.status,
      ready: trajectory.status === CascadeRunStatus.IDLE && latest !== null,
      stepIndex: latest?.stepIndex ?? null,
      response: latest?.response ?? null,
      rawResponse: latest?.rawResponse ?? null,
      messageId: latest?.messageId ?? null,
      outputId: latest?.outputId ?? null,
    };
  }

  async waitForCascadeIdle(
    cascadeId: string,
    maxWaitMs: number = 30000
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getCascadeStatus(cascadeId);

      if (status === CascadeRunStatus.IDLE) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `Cascade ${cascadeId} did not become idle within ${maxWaitMs}ms`
    );
  }

  async getModels(): Promise<ClientModelConfig[]> {
    const metadata = this.createMetadata();

    const isUnimplementedError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      return /unimplemented|not implemented/i.test(message);
    };

    const attempts: Array<() => Promise<ClientModelConfig[]>> = [
      async () => {
        const response = await this.client.getCascadeModelConfigs({ metadata });
        return response.clientModelConfigs;
      },
      async () => {
        const response = await this.client.getCommandModelConfigs({ metadata });
        return response.clientModelConfigs;
      },
      async () => {
        const response = await this.client.getUserStatus({ metadata });
        return response.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      },
    ];

    const getModelKey = (model: ClientModelConfig): string => {
      const directUid = model.modelUid?.trim();
      if (directUid) {
        return `uid:${directUid}`;
      }

      const aliasUid = model.modelOrAlias?.modelUid?.trim();
      if (aliasUid) {
        return `uid:${aliasUid}`;
      }

      const alias = model.modelOrAlias?.alias ?? 0;
      const enumModel = model.modelOrAlias?.model ?? 0;
      if (alias !== 0 || enumModel !== 0) {
        return `enum:${enumModel}:${alias}`;
      }

      return `label:${model.label.trim().toLowerCase()}`;
    };

    const mergedModels = new Map<string, ClientModelConfig>();
    let lastError: unknown = null;
    let hadSuccessfulCall = false;

    for (const attempt of attempts) {
      try {
        const models = await attempt();
        hadSuccessfulCall = true;

        for (const model of models) {
          const key = getModelKey(model);
          const existing = mergedModels.get(key);

          if (!existing) {
            mergedModels.set(key, model);
            continue;
          }

          if (!existing.modelUid && model.modelUid) {
            existing.modelUid = model.modelUid;
          }

          if (!existing.modelOrAlias && model.modelOrAlias) {
            existing.modelOrAlias = model.modelOrAlias;
          }

          if (!existing.label && model.label) {
            existing.label = model.label;
          }

          if (existing.disabled && !model.disabled) {
            existing.disabled = false;
          }
        }
      } catch (error) {
        lastError = error;
        if (!isUnimplementedError(error)) {
          throw error;
        }
      }
    }

    if (!hadSuccessfulCall && lastError) {
      throw lastError;
    }

    return Array.from(mergedModels.values()).sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    );
  }

  async getTrajectories(): Promise<{
    [key: string]: CascadeTrajectorySummary;
  }> {
    const response = await this.client.getAllCascadeTrajectories({
      includeUserInputs: false,
    });

    return response.trajectorySummaries;
  }
}
