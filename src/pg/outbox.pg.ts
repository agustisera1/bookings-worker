import { Outbox, query } from "./index.js";

const PENDING_BATCH_SIZE = 100;

export async function findPendingEvents(): Promise<Outbox[]> {
  const result = await query<Outbox>(
    `
    SELECT * FROM outbox
    WHERE published_at IS NULL
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [PENDING_BATCH_SIZE],
  );

  return result.rows;
}

export async function markAsPublished(
  id: string,
): Promise<{ id: string | null; ok: boolean }> {
  const result = await query<{ id: string }>(
    `
      UPDATE outbox 
      SET published_at = NOW()
      WHERE id = $1
      RETURNING id;
      `,
    [id],
  );

  if (result.rowCount === 0 || !result.rows.length) {
    return { id: null, ok: false };
  }

  return { id: result.rows[0].id, ok: true };
}
