import { Worker, createNodeRedisClient } from "bullmq";
import { createClient } from "redis";
import { emailsProcessor as ep } from "../processors/emails.js";
import { notificationsProcessor as np } from "../processors/notifications.js";

const url = process.env.REDIS_URL;
if (!url) throw new Error("[redis]: Missing REDIS_URL");

export const emailsWorker = new Worker("emails", ep, {
  autorun: false,
  connection: createNodeRedisClient(
    createClient({ url, name: "redis-emails-client" }),
  ),
});

export const notificationsWorker = new Worker("notifications", np, {
  autorun: false,
  connection: createNodeRedisClient(
    createClient({ url, name: "redis-notifications-client" }),
  ),
});
