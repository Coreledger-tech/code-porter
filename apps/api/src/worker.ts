import { closeDbPool } from "./db/client.js";
import { AsyncRunWorker } from "./run-worker.js";

async function main(): Promise<void> {
  const worker = new AsyncRunWorker();

  const shutdown = async (): Promise<void> => {
    worker.stop();
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

  await worker.start();
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error("Worker failed", error);
  await closeDbPool();
  process.exitCode = 1;
});
