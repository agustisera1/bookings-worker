import { createClient, RedisArgument } from "redis";

export const channels = {
  notifications: (target?: string) =>
    target ? `notifications:${target}` : "notifications:*", // Use wildcard for subscriptions
};

type RedisConnectionParams = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export function getRedisConnectionParams(): RedisConnectionParams {
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT);
  const password = process.env.REDIS_PASSWORD;
  const username = process.env.REDIS_USER;
  const params = { host, port, username, password };
  if (Object.values(params).some((val) => !val)) {
    throw new Error("[redis-config]: Missing connection params");
  }
  return params as RedisConnectionParams;
}

const url = process.env.REDIS_URL;
if (!url) throw new Error("[redis]: Missing REDIS_URL");

// Dedicated redis pub client for pushing SSE notifications (publish only).
export const pubClient = createClient({ url, name: "redis-pub-client" });

export async function publish(channel: RedisArgument, payload: RedisArgument) {
  const delivered = Number(await pubClient.publish(channel, payload));
  return delivered;
}
