import type { BridgeConfig, Logger } from "@codex-feishu-bridge/shared";

interface FeishuApiResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

interface FeishuTenantTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token: string;
  expire: number;
}

interface FeishuChatListItem {
  chat_id: string;
  description?: string;
  name: string;
}

interface FeishuChatListData {
  has_more?: boolean;
  items?: FeishuChatListItem[];
  page_token?: string;
}

export interface FeishuChatCandidate {
  chatId: string;
  description?: string;
  name: string;
}

function requireFeishuAppCredentials(config: BridgeConfig): void {
  if (config.feishuAppId && config.feishuAppSecret) {
    return;
  }

  throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required to resolve Feishu chats.");
}

async function getTenantAccessToken(config: BridgeConfig): Promise<string> {
  requireFeishuAppCredentials(config);

  const response = await fetch(new URL("/open-apis/auth/v3/tenant_access_token/internal", config.feishuBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain Feishu tenant token (${response.status})`);
  }

  const body = (await response.json()) as FeishuTenantTokenResponse;
  if (body.code !== 0) {
    throw new Error(`Feishu auth error ${body.code}: ${body.msg ?? "unknown error"}`);
  }

  return body.tenant_access_token;
}

function formatCandidates(candidates: FeishuChatCandidate[]): string {
  return candidates
    .slice(0, 10)
    .map((candidate) => `${candidate.name} (${candidate.chatId})`)
    .join(", ");
}

export async function listVisibleFeishuChats(config: BridgeConfig): Promise<FeishuChatCandidate[]> {
  const accessToken = await getTenantAccessToken(config);
  const candidates: FeishuChatCandidate[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const url = new URL("/open-apis/im/v1/chats", config.feishuBaseUrl);
    url.searchParams.set("page_size", "100");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
    });

    if (!response.ok) {
      throw new Error(`Feishu chat list failed (${response.status})`);
    }

    const body = (await response.json()) as FeishuApiResponse<FeishuChatListData>;
    if (body.code !== 0) {
      throw new Error(`Feishu chat list error ${body.code}: ${body.msg ?? "unknown error"}`);
    }

    for (const item of body.data.items ?? []) {
      candidates.push({
        chatId: item.chat_id,
        description: item.description,
        name: item.name,
      });
    }

    if (!body.data.has_more || !body.data.page_token) {
      return candidates;
    }

    pageToken = body.data.page_token;
  }
}

export async function resolveFeishuDefaultChatConfig(
  config: BridgeConfig,
  logger: Logger,
): Promise<BridgeConfig> {
  if (config.feishuDefaultChatId || !config.feishuDefaultChatName) {
    return config;
  }

  const candidates = await listVisibleFeishuChats(config);
  const matches = candidates.filter((candidate) => candidate.name === config.feishuDefaultChatName);

  if (matches.length === 1) {
    logger.info("resolved feishu default chat id from chat name", {
      chatId: matches[0]?.chatId,
      chatName: matches[0]?.name,
    });
    return {
      ...config,
      feishuDefaultChatId: matches[0]?.chatId,
    };
  }

  if (matches.length === 0) {
    throw new Error(
      `FEISHU_DEFAULT_CHAT_NAME "${config.feishuDefaultChatName}" did not match any visible chat. ` +
        `Visible candidates: ${formatCandidates(candidates) || "none"}`,
    );
  }

  throw new Error(
    `FEISHU_DEFAULT_CHAT_NAME "${config.feishuDefaultChatName}" matched multiple chats. ` +
      `Set FEISHU_DEFAULT_CHAT_ID explicitly. Candidates: ${formatCandidates(matches)}`,
  );
}
