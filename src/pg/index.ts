import { NotifyEventType } from "@tanstack/react-query";
import { Pool, QueryResult, QueryResultRow } from "pg";
import { EVENTS } from "../chat/types.js";

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
});

export const query = <R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[],
): Promise<QueryResult<R>> => {
  return pool.query<R>(text, params);
};

export type PgUser = {
  id: string;
  email: string;
  name: string;
  is_host: boolean;
  created_at: string;
  password_hash: string;
};

type BookingParty = "guest" | "host";
type BookingStatus = "pending" | "accepted" | "rejected" | "cancelled";
export type Booking = {
  id: string;
  listing_id: string;
  guest_id: string;
  start_date: string;
  end_date: string;
  status: BookingStatus;
  status_reason: string | null;
  // Money columns are NUMERIC(10,2) (005), which node-postgres returns as
  // strings to avoid float precision loss. Consumers convert at the edge.
  total_price: string;
  created_at: string;
  guests: number;
  refund_amount: string;
  cancelled_by: BookingParty | null;
  cancelled_at: string | null;
};

export type Outbox = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string; // Check to match with real events type
  payload: Record<string, unknown>;
  created_at: string;
  published_at: string | null;
};

export type NotificationType =
  | "pending"
  | "approved"
  | "rejected"
  | "updated"
  | "cancelled";
