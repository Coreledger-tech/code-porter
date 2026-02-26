import { Pool } from "pg";

const defaultDbPort = process.env.POSTGRES_HOST_PORT ?? "5433";
const defaultConnectionString = `postgresql://code_porter:code_porter@localhost:${defaultDbPort}/code_porter`;

const connectionString =
  process.env.DATABASE_URL ??
  defaultConnectionString;

export const dbPool = new Pool({
  connectionString
});

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await dbPool.query(text, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

export async function closeDbPool(): Promise<void> {
  await dbPool.end();
}
