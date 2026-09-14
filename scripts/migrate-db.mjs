/* global console, process */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error('DATABASE_URL is required for database migrations');
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, '../db/migrations');
const files = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+_[^/]+\.sql$/.test(file))
  .sort();

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
} catch {
  throw new Error('Database connection failed');
}
try {
  for (const file of files) {
    const version = file.slice(0, file.indexOf('_'));
    let applied = false;
    try {
      const result = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      applied = Boolean(result.rowCount);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === '42P01')) {
        throw error;
      }
    }
    if (applied) {
      continue;
    }
    const sql = await readFile(join(migrationsDirectory, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} catch {
  throw new Error('Database migration failed');
} finally {
  await client.end();
}
