import { buildApp } from "./app.js";
import { startSchedulers } from "./cron/index.js";
import { runMigrations } from "./db/index.js";

const app = buildApp();
let stopSchedulers: () => void = () => {};
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down AgentMesh hub");
  stopSchedulers();
  await app.close();
  process.exit(0);
}

async function bootstrap(): Promise<void> {
  runMigrations();
  stopSchedulers = startSchedulers();

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const port = Number.parseInt(process.env.PORT ?? "3777", 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ host, port });
}

bootstrap().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
