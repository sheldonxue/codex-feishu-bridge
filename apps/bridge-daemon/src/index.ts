import { createConsoleLogger, loadBridgeConfig, prepareBridgeDirectories } from "@codex-feishu-bridge/shared";

import { createBridgeHttpServer } from "./server/http";
import { createCodexRuntime } from "./runtime";
import { BridgeService } from "./service/bridge-service";

export interface BridgeDaemonHandle {
  close(): Promise<void>;
  port: number;
}

export async function startBridgeDaemon(): Promise<BridgeDaemonHandle> {
  const config = loadBridgeConfig();
  const logger = createConsoleLogger("bridge-daemon");

  await prepareBridgeDirectories(config);

  const runtime = createCodexRuntime(config, logger);
  await runtime.start();

  const service = new BridgeService({ config, logger, runtime });
  await service.initialize();

  const server = createBridgeHttpServer({ config, logger, runtime, service });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  logger.info(`bridge daemon listening on ${config.host}:${config.port}`);

  return {
    port: config.port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await service.dispose();
      await runtime.dispose();
    },
  };
}

if (require.main === module) {
  startBridgeDaemon().catch((error: unknown) => {
    console.error("bridge-daemon failed to start", error);
    process.exitCode = 1;
  });
}
