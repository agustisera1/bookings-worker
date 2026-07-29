import { JobsOptions, Queue } from "bullmq";
import { getRedisConnectionParams } from "./client.js";

const connection = getRedisConnectionParams();

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  // Counts, no booleanos: `true` borra el job al instante y no deja ventana que
  // inspeccionar. También es lo que acota la dedup por `jobId`.
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export const emailsQueue = new Queue("emails", {
  connection,
  defaultJobOptions,
});

export const notificationsQueue = new Queue("notifications", {
  connection,
  defaultJobOptions,
});
