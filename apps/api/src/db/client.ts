import { Pool } from "pg";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://code_porter:code_porter@localhost:5432/code_porter";

export const dbPool = new Pool({
  connectionString
});

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
  const result = await dbPool.query(text, params);
  return { rows: result.rows as T[] };
}

export async function closeDbPool(): Promise<void> {
  await dbPool.end();
}
