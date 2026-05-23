/**
 * MariaDB connection pool. All queries use parameter binding — never
 * interpolate user input into SQL strings.
 */
import * as mariadb from "mariadb";
import { config } from "./config.ts";

export const pool = mariadb.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: 5,
  acquireTimeout: 10_000,
  // Return rows as plain objects. Disable BigInt for INT columns we know fit in
  // a normal Number (we have no BIGINT columns).
  bigIntAsNumber: true,
  // Important: we never interpolate, but defense in depth.
  multipleStatements: false,
});

/** Run a SELECT and return an array of rows. */
export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await pool.getConnection();
  try {
    const rows = await conn.query(sql, params);
    // mariadb driver attaches `meta` to the array; strip it for cleanliness.
    if (Array.isArray(rows)) {
      const cleaned: T[] = [];
      for (const r of rows) cleaned.push(r);
      return cleaned;
    }
    // Normalize single-object results into a one-element array so callers
    // (and queryOne) can always index into the returned value safely.
    return [rows] as unknown as T[];
  } finally {
    conn.release();
  }
}

/** Run a single-row SELECT. Returns undefined if no rows. */
export async function queryOne<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

/** Run an INSERT/UPDATE/DELETE. Returns affectedRows and insertId. */
export async function execute(
  sql: string,
  params: unknown[] = [],
): Promise<{ affectedRows: number; insertId: number }> {
  const conn = await pool.getConnection();
  try {
    const result: any = await conn.query(sql, params);
    return {
      affectedRows: Number(result.affectedRows ?? 0),
      insertId: Number(result.insertId ?? 0),
    };
  } finally {
    conn.release();
  }
}

/** Transaction helper. The callback receives an object with the same query/execute API. */
export async function transaction<T>(
  fn: (tx: {
    query: <U = any>(sql: string, params?: unknown[]) => Promise<U[]>;
    queryOne: <U = any>(sql: string, params?: unknown[]) => Promise<U | undefined>;
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number; insertId: number }>;
  }) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const txQuery = async <U = any>(sql: string, params: unknown[] = []): Promise<U[]> => {
      const rows = await conn.query(sql, params);
      // mariadb driver sometimes returns a single object for aggregate/selects
      // instead of an array. Mirror the top-level `query()` behaviour: when
      // an array is returned, return a cleaned array; otherwise wrap the
      // single-row result in an array so callers always get a consistent
      // array shape.
      if (Array.isArray(rows)) {
        const cleaned: U[] = [];
        for (const r of rows) cleaned.push(r);
        return cleaned;
      }
      return [rows] as unknown as U[];
    };
    const result = await fn({
      query: txQuery,
      queryOne: async <U = any>(sql: string, params: unknown[] = []) => {
        const rows = await txQuery<U>(sql, params);
        return rows[0];
      },
      execute: async (sql: string, params: unknown[] = []) => {
        const r: any = await conn.query(sql, params);
        return {
          affectedRows: Number(r.affectedRows ?? 0),
          insertId: Number(r.insertId ?? 0),
        };
      },
    });
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    throw err;
  } finally {
    conn.release();
  }
}
