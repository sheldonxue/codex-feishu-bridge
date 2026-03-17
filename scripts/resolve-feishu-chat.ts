import { createConsoleLogger, loadBridgeConfig } from "../packages/shared/src/index";
import {
  listVisibleFeishuChats,
  resolveFeishuDefaultChatConfig,
} from "../apps/bridge-daemon/src/feishu/chat-resolution";

function readFlagValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

async function main(): Promise<void> {
  const logger = createConsoleLogger("feishu-resolve-chat");
  const listOnly = process.argv.slice(2).includes("--list");
  const nameOverride = readFlagValue("--name");
  const config = loadBridgeConfig(process.env, process.cwd());

  if (nameOverride) {
    config.feishuDefaultChatName = nameOverride;
  }

  if (listOnly || !config.feishuDefaultChatName) {
    const chats = await listVisibleFeishuChats(config);
    console.log(JSON.stringify({ chats }, null, 2));
    return;
  }

  const resolved = await resolveFeishuDefaultChatConfig(config, logger);
  console.log(
    JSON.stringify(
      {
        chatId: resolved.feishuDefaultChatId,
        chatName: resolved.feishuDefaultChatName,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error("failed to resolve Feishu chat", error);
  process.exitCode = 1;
});
