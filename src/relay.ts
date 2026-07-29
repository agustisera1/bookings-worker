import { emailsQueue, notificationsQueue } from "./redis/queues.js";
import { Outbox } from "./pg/index.js";
import * as outboxRepo from "./pg/outbox.pg.js";
import { toJobs } from "./outbox/fan-out.js";

const queues = {
  emails: emailsQueue,
  notifications: notificationsQueue,
};

class Relay {
  running = false;
  interval = 10_000; // Every 10 secs
  events: Outbox[] = [];

  constructor() {
    this.running = true;
    this.events = [];
  }

  stop = () => {
    this.running = false;
  };

  start = async () => {
    while (this.running) {
      try {
        await this.pollEvents();
        await this.dispatch();
      } catch (err) {
        console.error("[relay]: poll/dispatch failed", err);
      }

      await this.sleep();
    }
  };

  dispatchEvent = async (event: Outbox) => {
    try {
      const jobs = await toJobs(event);

      for (const job of jobs ?? []) {
        await queues[job.queue].add(job.queue, job.data, job.opts);
      }

      // at-least-once
      const published = await outboxRepo.markAsPublished(event.id);
      if (!published.ok) {
        console.error("[dispatchEvent]: could not mark as published", event.id);
      }
    } catch (err) {
      console.error("[dispatchEvent]: could not dispatch event", event.id, err);
    }
  };

  dispatch = async () => {
    if (this.events.length === 0) return;
    for (const event of this.events) {
      await this.dispatchEvent(event);
    }
  };

  sleep() {
    return new Promise((resolve) => setTimeout(resolve, this.interval));
  }

  pollEvents = async () => {
    console.log("poll called", this.events);
    try {
      const pending = await outboxRepo.findPendingEvents();
      this.events = pending;
    } catch {
      console.error("[pollEvents]: Could not retrieve the events from DB");
    }
  };
}

export const relay = new Relay();
