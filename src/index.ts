import "dotenv/config.js";
import { emailsWorker, notificationsWorker } from "./redis/workers.js";
import { pubClient } from "./redis/client.js";
import { io as chatServer } from "./redis/socket.js";
import { relay } from "./relay.js";

// node-redis emits `error` events; without a listener they throw and can crash
// the process. Attach before anything connects.
pubClient.on("error", (err) => console.error("[pubClient]:", err));
emailsWorker.on("error", (err) => console.error("[emailsWorker]:", err));
notificationsWorker.on("error", (err) =>
  console.error("[notificationsWorker]:", err),
);

// Startup order matters: the notifications processor publishes on `pubClient`,
// so that connection must be up before the workers start pulling jobs. The
// workers are created with `autorun: false` precisely so we gate them here.
// Port the socket.io chat server listens on. From env so it can differ per
// environment; falls back to 4000 for local dev.
const socketPort = Number(process.env.SOCKET_PORT) || 4000;

async function initialize() {
  await pubClient.connect();
  console.info("[pubClient]: initialized");
  chatServer.listen(socketPort);
  console.info(`[chatServer]: listening on ${socketPort}`);
  relay.start();
  console.info("[relay]: initialized");

  // run() starts each processing loop; its promise resolves only when the
  // worker closes, so we start them without awaiting.
  emailsWorker.run().catch((err) => console.error("[emailsWorker] run:", err));
  notificationsWorker
    .run()
    .catch((err) => console.error("[notificationsWorker] run:", err));
  console.info("[workers]: running");
}

initialize().catch((err) => {
  console.error("[initialize]: startup failed", err);
  process.exit(1);
});

// Graceful shutdown. worker.close() stops the loop and closes the worker's own
// BullMQ connection; `pubClient` is ours, so we close it explicitly.
async function shutdown() {
  await emailsWorker.close();
  await notificationsWorker.close();
  await pubClient.close();
  relay.stop();
  console.info("[shutdown]: connections closed");
  process.exit(0);
}

// SIGINT -> Ctrl+C; SIGTERM -> docker stop / tsx watch reloads.
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
