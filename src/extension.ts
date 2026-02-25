import * as vscode from "vscode";
import { ChatParams } from "./types";
import { Client } from "./client";
import { HttpServer } from "./http_server";

const CHAT_PARAM_KEYS: Array<keyof ChatParams> = [
  "csrfToken",
  "languageServerUrl",
  "apiKey",
  "ideName",
  "ideVersion",
  "extensionName",
  "extensionVersion",
  "locale",
  "osName",
  "architecture",
];

let client: Client | null = null;
let httpServer: HttpServer | null = null;
let windsurfHandler: vscode.Disposable | null = null;
let resolveClientReady: (() => void) | null = null;
const clientReady = new Promise<void>((resolve) => {
  resolveClientReady = resolve;
});

function markClientReady() {
  if (resolveClientReady) {
    resolveClientReady();
    resolveClientReady = null;
  }
}

async function waitForClientInitialization(timeoutMs: number): Promise<boolean> {
  if (client) {
    return true;
  }

  await Promise.race([
    clientReady,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  return client !== null;
}

function isChatParams(value: unknown): value is ChatParams {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return CHAT_PARAM_KEYS.every((key) => typeof record[key] === "string");
}

function parseJson(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function parseBase64Json(input: string): unknown | null {
  try {
    const decoded = Buffer.from(input, "base64").toString("utf8");
    return parseJson(decoded);
  } catch {
    return null;
  }
}

function extractChatParams(args: unknown[]): ChatParams | null {
  for (const arg of args) {
    if (isChatParams(arg)) {
      return arg;
    }

    if (typeof arg !== "string" || arg.length === 0) {
      continue;
    }

    const rawJson = parseJson(arg);
    if (isChatParams(rawJson)) {
      return rawJson;
    }

    const base64Json = parseBase64Json(arg);
    if (isChatParams(base64Json)) {
      return base64Json;
    }
  }

  return null;
}

async function forwardInitializeCascade(args: unknown[]) {
  try {
    await vscode.commands.executeCommand("windsurf.initializeCascade", ...args);
  } catch (error) {
    console.error("Failed to forward windsurf.initializeCascade:", error);
  }
}

async function autoStartServerIfEnabled() {
  if (!client || httpServer?.isRunning()) {
    return;
  }

  const config = vscode.workspace.getConfiguration("windsurfapi");
  const autoStart = config.get<boolean>("autoStart", false);

  if (!autoStart) {
    return;
  }

  const port = config.get<number>("port", 47923);
  httpServer = new HttpServer(client, port);
  try {
    await httpServer.start();
    console.log(`Server auto-started on port ${port}`);
  } catch (error) {
    console.error("Failed to auto-start server:", error);
  }
}

function registerWindsurfInitHandler() {
  windsurfHandler?.dispose();

  windsurfHandler = vscode.commands.registerCommand(
    "windsurf.initializeCascade",
    async (...args: unknown[]) => {
      const params = extractChatParams(args);
      if (params) {
        client = new Client(params);
        markClientReady();
        console.log("Windsurf initialized");
        await autoStartServerIfEnabled();

        const handler = windsurfHandler;
        windsurfHandler = null;
        handler?.dispose();
        setTimeout(() => {
          void forwardInitializeCascade(args);
        });
        return;
      }

      console.warn(
        "windsurf.initializeCascade called without recognizable initialization payload; forwarding call and continuing to wait for initialization."
      );

      const handler = windsurfHandler;
      windsurfHandler = null;
      handler?.dispose();

      await forwardInitializeCascade(args);
      registerWindsurfInitHandler();
    }
  );
}

export function activate(context: vscode.ExtensionContext) {
  registerWindsurfInitHandler();

  const startServerCommand = vscode.commands.registerCommand(
    "windsurfapi.startServer",
    async () => {
      if (!client) {
        const initialized = await waitForClientInitialization(2500);
        if (!initialized) {
          vscode.window.showErrorMessage(
            "Windsurf API is not initialized. Open Windsurf chat/cascade once (signed in), then run 'Windsurf API: Start Server' again."
          );
          return;
        }
      }

      if (!client) {
        vscode.window.showErrorMessage("Windsurf API initialization failed");
        return;
      }

      if (httpServer?.isRunning()) {
        vscode.window.showWarningMessage("Server already running");
        return;
      }

      try {
        const config = vscode.workspace.getConfiguration("windsurfapi");
        const port = config.get<number>("port", 47923);

        httpServer = new HttpServer(client, port);
        await httpServer.start();

        vscode.window.showInformationMessage(`Server started on port ${port}`);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const stopServerCommand = vscode.commands.registerCommand(
    "windsurfapi.stopServer",
    async () => {
      if (!httpServer?.isRunning()) {
        vscode.window.showWarningMessage("Server not running");
        return;
      }

      try {
        await httpServer.stop();
        vscode.window.showInformationMessage("Server stopped");
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  context.subscriptions.push(
    { dispose: () => windsurfHandler?.dispose() },
    startServerCommand,
    stopServerCommand
  );
}

export async function deactivate(): Promise<void> {
  windsurfHandler?.dispose();
  windsurfHandler = null;

  if (httpServer?.isRunning()) {
    try {
      await httpServer.stop();
    } catch (error) {
      console.error("Failed to stop HTTP server during deactivate:", error);
    }
  }

  httpServer = null;
  client = null;
}
