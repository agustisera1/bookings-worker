import { query, PgProcessedEvent } from "./index.js";

/**
 * Claim del efecto: el `INSERT` es a la vez el chequeo y la marca, así que dos
 * ejecuciones en paralelo no pueden pasar las dos — la perdedora espera en el
 * índice de la PK y sale por el `ON CONFLICT`. `false` = ya lo procesó otro.
 */
export async function insertEvent(
  eventId: string,
  consumer: string,
): Promise<boolean> {
  const inserted = await query<PgProcessedEvent>(
    `
    INSERT INTO processed_events (event_id, consumer)
    VALUES ($1, $2)
    ON CONFLICT DO NOTHING
    RETURNING processed_at;`,
    [eventId, consumer],
  );

  if (inserted.rowCount === 0) return false;
  return true;
}
