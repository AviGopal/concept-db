#!/usr/bin/env bun
/**
 * Apply concept-db schema to SurrealDB
 */

import { Surreal } from 'surrealdb';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const SURREAL_URL = process.env.SURREALDB_URL || 'http://localhost:8000';
const SURREAL_NS = process.env.SURREALDB_NAMESPACE || 'activity-system';
const SURREAL_DB = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREAL_USER = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASS = process.env.SURREALDB_PASSWORD || 'changeme';

async function main() {
  console.log('Connecting to SurrealDB...');
  console.log(`  URL: ${SURREAL_URL}`);
  console.log(`  Namespace: ${SURREAL_NS}`);
  console.log(`  Database: ${SURREAL_DB}`);

  const db = new Surreal();

  try {
    await db.connect(SURREAL_URL);
    await db.signin({
      username: SURREAL_USER,
      password: SURREAL_PASS,
    });
    await db.use({
      namespace: SURREAL_NS,
      database: SURREAL_DB,
    });

    console.log('Connected successfully\n');

    // Get SQL files
    const sqlDir = join(import.meta.dir, '..', 'sql');
    const subdirs = ['core', 'upkeep'];

    for (const subdir of subdirs) {
      const dirPath = join(sqlDir, subdir);

      try {
        const files = await readdir(dirPath);
        const sqlFiles = files.filter(f => f.endsWith('.surql')).sort();

        for (const file of sqlFiles) {
          const filePath = join(dirPath, file);
          console.log(`Applying ${subdir}/${file}...`);

          const content = await readFile(filePath, 'utf-8');

          // Split by semicolons and execute each statement. Strip comment
          // LINES inside each chunk rather than dropping chunks that start
          // with '--': a statement preceded by its own comment block (every
          // statement in 004-bm25-search.surql) was previously discarded
          // whole, so concept_analyzer + the FTS indexes silently never
          // applied on a fresh datastore (found 2026-07-02 from-zero boot).
          const statements = content
            .split(';')
            .map(s => s
              .split('\n')
              .filter(line => !line.trim().startsWith('--'))
              .join('\n')
              .trim())
            .filter(s => s.length > 0);

          for (const statement of statements) {
            if (statement) {
              try {
                await db.query(statement + ';');
              } catch (error) {
                const err = error as Error;
                // Ignore "already exists" errors
                if (!err.message.includes('already exists')) {
                  console.error(`  Error in statement: ${err.message}`);
                  console.error(`  Statement: ${statement.slice(0, 100)}...`);
                }
              }
            }
          }

          console.log(`  ✓ Applied ${file}`);
        }
      } catch (error) {
        const err = error as Error;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        console.log(`  Skipping ${subdir}/ (directory not found)`);
      }
    }

    // Verify tables
    console.log('\nVerifying tables...');
    const tables = await db.query<[{ tables: string[] }]>('INFO FOR DB');

    console.log('Tables created:');
    const tableInfo = tables[0];
    if (tableInfo && typeof tableInfo === 'object' && 'tables' in tableInfo) {
      const tableNames = Object.keys(tableInfo.tables as object);
      for (const table of tableNames) {
        if (table.startsWith('concept')) {
          console.log(`  ✓ ${table}`);
        }
      }
    }

    console.log('\n✓ Schema applied successfully');

  } catch (error) {
    const err = error as Error;
    console.error('Failed to apply schema:', err.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
