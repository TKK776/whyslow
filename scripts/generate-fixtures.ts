/**
 * Regenerate the fixture corpus against a real Postgres.
 *
 *   docker compose up -d
 *   npm run fixtures:generate
 *   docker compose down -v
 *
 * Each entry below builds a table, then runs a query written to force one
 * specific plan shape. Run this against each Postgres version you claim to
 * support: the JSON fields shift between releases and this is the only way to
 * find out before a user does.
 *
 *   PGVERSION=16 docker compose up -d && npm run fixtures:generate
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, '..', 'src', 'fixtures', 'generated');
const CONN =
  process.env.DATABASE_URL ?? 'postgres://whyslow:whyslow@localhost:54329/whyslow';

interface Shape {
  name: string;
  /** Runs once, before the query. Safe to re-run. */
  setup: string[];
  query: string;
  /** Session settings applied before the query, to force the shape. */
  settings?: string[];
}

const SHAPES: Shape[] = [
  {
    name: 'seq-scan-large-filter',
    setup: [
      `DROP TABLE IF EXISTS gen_orders`,
      `CREATE TABLE gen_orders (id bigserial primary key, status text, placed_at date, amount numeric)`,
      `INSERT INTO gen_orders (status, placed_at, amount)
         SELECT CASE WHEN i % 10 = 0 THEN 'shipped' ELSE 'pending' END,
                DATE '2025-01-01' + (i % 700),
                (i % 500)::numeric
         FROM generate_series(1, 500000) i`,
      `ANALYZE gen_orders`,
    ],
    query: `SELECT * FROM gen_orders WHERE status = 'shipped' AND amount > 100`,
    settings: ['SET enable_indexscan = off', 'SET enable_bitmapscan = off'],
  },
  {
    name: 'nested-loop-many-iterations',
    setup: [
      `DROP TABLE IF EXISTS gen_sessions, gen_events`,
      `CREATE TABLE gen_sessions (id int primary key)`,
      `CREATE TABLE gen_events (id bigserial primary key, session_id int, kind text)`,
      `INSERT INTO gen_sessions SELECT generate_series(1, 20000)`,
      `INSERT INTO gen_events (session_id, kind)
         SELECT (i % 20000) + 1, 'click' FROM generate_series(1, 60000) i`,
      `CREATE INDEX ON gen_events (session_id)`,
      `ANALYZE gen_sessions, gen_events`,
    ],
    query: `SELECT s.id, e.kind FROM gen_sessions s JOIN gen_events e ON e.session_id = s.id`,
    settings: ['SET enable_hashjoin = off', 'SET enable_mergejoin = off'],
  },
  {
    name: 'sort-spilling-to-disk',
    setup: [
      `DROP TABLE IF EXISTS gen_wide`,
      `CREATE TABLE gen_wide (id bigserial, payload text)`,
      `INSERT INTO gen_wide (payload) SELECT repeat(md5(i::text), 8) FROM generate_series(1, 300000) i`,
      `ANALYZE gen_wide`,
    ],
    query: `SELECT * FROM gen_wide ORDER BY payload`,
    settings: ['SET work_mem = "64kB"'],
  },
  {
    name: 'hash-join-multiple-batches',
    setup: [
      `DROP TABLE IF EXISTS gen_a, gen_b`,
      `CREATE TABLE gen_a (id int, payload text)`,
      `CREATE TABLE gen_b (id int, payload text)`,
      `INSERT INTO gen_a SELECT i, md5(i::text) FROM generate_series(1, 400000) i`,
      `INSERT INTO gen_b SELECT i, md5(i::text) FROM generate_series(1, 400000) i`,
      `ANALYZE gen_a, gen_b`,
    ],
    query: `SELECT a.id FROM gen_a a JOIN gen_b b ON b.id = a.id`,
    settings: ['SET work_mem = "128kB"', 'SET enable_mergejoin = off'],
  },
  {
    name: 'parallel-seq-scan',
    setup: [
      `DROP TABLE IF EXISTS gen_big`,
      `CREATE TABLE gen_big (id bigserial, n int)`,
      `INSERT INTO gen_big (n) SELECT (random() * 1000)::int FROM generate_series(1, 800000)`,
      `ANALYZE gen_big`,
    ],
    query: `SELECT sum(n) FROM gen_big`,
    settings: [
      'SET max_parallel_workers_per_gather = 2',
      'SET parallel_setup_cost = 0',
      'SET parallel_tuple_cost = 0',
      'SET min_parallel_table_scan_size = 0',
    ],
  },
  {
    name: 'bitmap-heap-lossy',
    setup: [
      `DROP TABLE IF EXISTS gen_measurements`,
      `CREATE TABLE gen_measurements (id bigserial, sensor_id int, reading numeric)`,
      `INSERT INTO gen_measurements (sensor_id, reading)
         SELECT (i % 50) + 1, random() * 100 FROM generate_series(1, 600000) i`,
      `CREATE INDEX ON gen_measurements (sensor_id)`,
      `ANALYZE gen_measurements`,
    ],
    query: `SELECT * FROM gen_measurements WHERE sensor_id < 30`,
    settings: ['SET work_mem = "64kB"', 'SET enable_seqscan = off'],
  },
  {
    name: 'cte-materialized',
    setup: [
      `DROP TABLE IF EXISTS gen_sales`,
      `CREATE TABLE gen_sales (region_id int, amount numeric)`,
      `INSERT INTO gen_sales SELECT (i % 40) + 1, (i % 900)::numeric FROM generate_series(1, 200000) i`,
      `ANALYZE gen_sales`,
    ],
    query: `WITH totals AS MATERIALIZED (
              SELECT region_id, sum(amount) AS total FROM gen_sales GROUP BY region_id
            )
            SELECT * FROM totals WHERE total > 1000`,
  },
  {
    name: 'partition-append',
    setup: [
      `DROP TABLE IF EXISTS gen_readings`,
      `CREATE TABLE gen_readings (taken_on date, value numeric) PARTITION BY RANGE (taken_on)`,
      `CREATE TABLE gen_readings_01 PARTITION OF gen_readings FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')`,
      `CREATE TABLE gen_readings_02 PARTITION OF gen_readings FOR VALUES FROM ('2026-02-01') TO ('2026-03-01')`,
      `CREATE TABLE gen_readings_03 PARTITION OF gen_readings FOR VALUES FROM ('2026-03-01') TO ('2026-04-01')`,
      `INSERT INTO gen_readings SELECT DATE '2026-01-01' + (i % 89), random() * 50 FROM generate_series(1, 90000) i`,
      `ANALYZE gen_readings`,
    ],
    query: `SELECT count(*) FROM gen_readings WHERE value > 10`,
  },
  {
    name: 'no-analyze-plain-explain',
    setup: [
      `DROP TABLE IF EXISTS gen_tiny`,
      `CREATE TABLE gen_tiny (id int primary key)`,
    ],
    query: `SELECT * FROM gen_tiny WHERE id = 1`,
  },
];

function psql(sql: string): string {
  return execFileSync('psql', [CONN, '-X', '-q', '-A', '-t', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  try {
    psql('SELECT 1');
  } catch {
    console.error(
      `\nCannot reach Postgres at ${CONN}.\n` +
        'Run `docker compose up -d` first, or set DATABASE_URL.\n',
    );
    process.exit(1);
  }

  const version = psql('SHOW server_version').trim();
  console.log(`Generating against Postgres ${version}\n`);

  for (const shape of SHAPES) {
    process.stdout.write(`  ${shape.name} ... `);

    try {
      for (const stmt of shape.setup) psql(stmt);

      const analyzeClause = shape.name.startsWith('no-analyze')
        ? '(FORMAT JSON)'
        : '(ANALYZE, BUFFERS, FORMAT JSON)';

      const prelude = (shape.settings ?? []).map((s) => `${s};`).join(' ');
      const raw = psql(`${prelude} EXPLAIN ${analyzeClause} ${shape.query}`);

      const parsed: unknown = JSON.parse(raw);
      const path = join(OUT_DIR, `${shape.name}-pg${version.split('.')[0]}.json`);
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

      console.log('ok');
    } catch (error) {
      console.log('failed');
      console.error(`    ${(error as Error).message.split('\n')[0]}`);
    }
  }

  console.log(`\nWritten to ${OUT_DIR}`);
  console.log('Run `npm run test:update` to record snapshots for the new fixtures.\n');
}

main();
