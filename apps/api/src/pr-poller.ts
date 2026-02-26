import { closeDbPool } from "./db/client.js";
import { PrLifecyclePollerWorker } from "./pr-poller-worker.js";

async function main(): Promise<void> {
  const poller = new PrLifecyclePollerWorker();

  const shutdown = async (): Promise<void> => {
    poller.stop();
    await closeDbPool();
  };

  process.on("SIGINT", () => {
    shutdown()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        process.exit();
      });
  });

  process.on("SIGTERM", () => {
    shutdown()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        process.exit();
      });
  });

  await poller.start();
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error("PR poller failed", error);
  await closeDbPool();
  process.exitCode = 1;
});
