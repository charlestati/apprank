// collector_state: small key/value config + learned state in D1, so a redeploy
// never loses discovery (learned rate, cursors, discovered ids).

export async function getState(
  db: D1Database,
  key: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM collector_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function getStateJson<T>(
  db: D1Database,
  key: string
): Promise<T | null> {
  const v = await getState(db, key);
  return v === null ? null : (JSON.parse(v) as T);
}

export async function setState(
  db: D1Database,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .bind(key, value, Date.now())
    .run();
}

export async function setStateJson(
  db: D1Database,
  key: string,
  value: unknown
): Promise<void> {
  await setState(db, key, JSON.stringify(value));
}

export async function recordFetchError(
  db: D1Database,
  e: {
    endpoint: string;
    params?: string;
    httpStatus?: number;
    responseMs?: number;
    // A closed vocabulary. The data-health page groups on this, so anything
    // per-incident belongs in `message`, never here.
    errorClass: string;
    message?: string;
    r2Key?: string;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO fetch_error (fetched_at, endpoint, params, http_status, response_ms, error_class, message, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      Date.now(),
      e.endpoint,
      e.params ?? null,
      e.httpStatus ?? null,
      e.responseMs ?? null,
      e.errorClass,
      e.message ?? null,
      e.r2Key ?? null
    )
    .run();
}
