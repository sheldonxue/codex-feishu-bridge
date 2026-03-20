import * as Lark from "@larksuiteoapi/node-sdk";

import type { Logger } from "@codex-feishu-bridge/shared";

import type { FeishuInteractiveCard } from "./cards";
import type {
  FeishuCardActionEvent,
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
  register(handles: Record<string, (data: any) => Promise<unknown> | unknown>): unknown;
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

function parsePreview(rawContent: string | undefined): string | undefined {
  if (!rawContent) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawContent) as { text?: string };
    return parsed.text?.trim().slice(0, 120) ?? rawContent.trim().slice(0, 120);
  } catch {
    return rawContent.trim().slice(0, 120);
  }
}

function summarizeIncomingPayload(
  message: FeishuIncomingMessage | undefined,
  sender: FeishuIncomingSender | undefined,
): Record<string, string | undefined> {
  return {
    actorId: sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id,
    messageId: message?.message_id,
    rootId: message?.root_id,
    parentId: message?.parent_id,
    threadId: message?.thread_id,
    chatId: message?.chat_id,
    messageType: message?.message_type,
    textPreview: parsePreview(message?.content),
  };
}

function summarizeCardActionPayload(
  event: FeishuCardActionEvent | undefined,
): Record<string, string | undefined> {
  const actionValue =
    typeof event?.action?.value === "string"
      ? undefined
      : event?.action?.value;
  return {
    openId: event?.open_id,
    userId: event?.user_id,
    tenantKey: event?.tenant_key,
    openMessageId: event?.open_message_id,
    actionTag: event?.action?.tag,
    actionOption: event?.action?.option,
    actionKind: actionValue?.kind,
    threadKey: actionValue?.threadKey,
    taskId: actionValue?.taskId,
  };
}

export function createFeishuLongConnectionFactory(
  sdk: LarkSdkLike = Lark as unknown as LarkSdkLike,
): LongConnectionFactory {
  return async ({ config, logger, onMessage, onCardAction }) => {
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
        logger.info("received feishu long-connection event", summarizeIncomingPayload(payload.message, payload.sender));
        await onMessage(payload.message, payload.sender);
      },
      "card.action.trigger": async (data: FeishuCardActionEvent): Promise<FeishuInteractiveCard | void> => {
        logger.info("received feishu long-connection card action", summarizeCardActionPayload(data));
        return onCardAction(data);
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
