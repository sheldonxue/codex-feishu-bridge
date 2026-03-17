import * as Lark from "@larksuiteoapi/node-sdk";

import type { Logger } from "@codex-feishu-bridge/shared";

import type {
  FeishuIncomingMessage,
  FeishuIncomingSender,
  LongConnectionFactory,
} from "./bridge";

interface LarkLogger {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface LarkEventDispatcherLike {
  register(handles: Record<string, (data: any) => Promise<void> | void>): unknown;
}

interface LarkEventDispatcherConstructor {
  new (params: any): LarkEventDispatcherLike;
}

interface LarkWsClientLike {
  close(params?: { force?: boolean }): void;
  start(params: { eventDispatcher: unknown }): Promise<void>;
}

interface LarkWsClientConstructor {
  new (params: any): LarkWsClientLike;
}

interface LarkSdkLike {
  AppType: {
    SelfBuild: unknown;
  };
  EventDispatcher: LarkEventDispatcherConstructor;
  LoggerLevel: {
    info: unknown;
  };
  WSClient: LarkWsClientConstructor;
}

function joinParts(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(" ");
}

function createSdkLogger(logger: Logger): LarkLogger {
  return {
    debug: (...args) => {
      logger.info(joinParts(args));
    },
    error: (...args) => {
      logger.error(joinParts(args));
    },
    info: (...args) => {
      logger.info(joinParts(args));
    },
    trace: (...args) => {
      logger.info(joinParts(args));
    },
    warn: (...args) => {
      logger.warn(joinParts(args));
    },
  };
}

function extractMessagePayload(data: {
  message?: FeishuIncomingMessage;
  sender?: FeishuIncomingSender;
}): {
  message?: FeishuIncomingMessage;
  sender?: FeishuIncomingSender;
} {
  return {
    message: data.message,
    sender: data.sender,
  };
}

export function createFeishuLongConnectionFactory(
  sdk: LarkSdkLike = Lark as unknown as LarkSdkLike,
): LongConnectionFactory {
  return async ({ config, logger, onMessage }) => {
    const sdkLogger = createSdkLogger(logger);
    const wsClient = new sdk.WSClient({
      appId: config.feishuAppId!,
      appSecret: config.feishuAppSecret!,
      appType: sdk.AppType.SelfBuild,
      autoReconnect: true,
      domain: config.feishuBaseUrl,
      logger: sdkLogger,
      loggerLevel: sdk.LoggerLevel.info,
    });
    const eventDispatcher = new sdk.EventDispatcher({
      logger: sdkLogger,
      loggerLevel: sdk.LoggerLevel.info,
    }).register({
      "im.message.receive_v1": async (data: {
        message?: FeishuIncomingMessage;
        sender?: FeishuIncomingSender;
      }) => {
        const payload = extractMessagePayload(data);
        await onMessage(payload.message, payload.sender);
      },
    });

    await wsClient.start({ eventDispatcher });

    return {
      stop: async () => {
        wsClient.close({ force: true });
      },
    };
  };
}
