/**
 * PF-03: profile the queries the API really runs, with their real plans.
 * DISPOSABLE DATABASES ONLY.
 *
 * ===========================================================================
 * Rather than hand-copying SQL that Prisma might write differently, this has
 * Postgres explain every statement the running API executes, by turning on
 * `auto_explain` for ONE database (an `ALTER DATABASE … SET`, so no server
 * restart and no other database is affected), then reads the plans back from
 * the server log.
 *
 *   node scripts/load/profile-queries.mjs enable           # then restart the API
 *   (drive load: scripts/load/run-load.mjs)
 *   node scripts/load/profile-queries.mjs disable          # always, afterwards
 *   node scripts/load/profile-queries.mjs report <server.log> <byteOffset> [out.md]
 *
 * `enable` prints the log's current size; pass it as the offset so the report
 * reads only this run. Settings take effect on NEW connections, which is why
 * the API is restarted after `enable`.
 *
 * The report groups plans by query text (Prisma sends `$n` parameters, so one
 * text is one query shape), ranks them by total time, and for each lists the
 * scans: an index scan names its index, a sequential scan on a table over
 * SEQ_SCAN_ROWS rows is flagged, since that is the shape that grows with the
 * data. Durations include EXPLAIN ANALYZE timing overhead; they rank queries,
 * they are not the latency figures (run-load.mjs measures those without it).
 * ===========================================================================
 */

import { closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';

import { WHOLLY_DISPOSABLE } from '../../test/support/isolation-guard.mjs';

const SEQ_SCAN_ROWS = 5000;
const [mode, logPath, offsetArg, outPath] = process.argv.slice(2);

async function withDatabase(fn) {
  const databaseModule = await import('../../packages/database/dist/index.js');
  const { createPrismaClient } = databaseModule.default ?? databaseModule;
  const prisma = createPrismaClient();
  try {
    const db = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
    if (!WHOLLY_DISPOSABLE.includes(db)) {
      throw new Error(`REFUSING: "${String(db)}" is not a wholly disposable database.`);
    }
    return await fn(prisma, db);
  } finally {
    await prisma.$disconnect();
  }
}

// Identifiers cannot be parameters; `db` is checked against the allowlist above.
const SETTINGS = [
  ['session_preload_libraries', 'auto_explain'],
  ['auto_explain.log_min_duration', '0'],
  ['auto_explain.log_analyze', 'on'],
  ['auto_explain.log_buffers', 'on'],
  ['auto_explain.log_format', 'json'],
  ['auto_explain.sample_rate', process.env.SAMPLE_RATE ?? '0.25'],
];

if (mode === 'enable') {
  await withDatabase(async (prisma, db) => {
    for (const [name, value] of SETTINGS) {
      await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET ${name} = '${value}'`);
    }
    const log = (await prisma.$queryRaw`SELECT current_setting('data_directory') AS d`)[0]?.d;
    console.log(
      `auto_explain enabled on ${db} for new connections (data directory ${String(log)}).`,
    );
  });
  if (logPath) console.log(`log offset: ${String(statSync(logPath).size)}`);
} else if (mode === 'disable') {
  await withDatabase(async (prisma, db) => {
    for (const [name] of SETTINGS) {
      await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" RESET ${name}`);
    }
    console.log(`auto_explain settings reset on ${db}.`);
  });
} else if (mode === 'report') {
  report(logPath, Number(offsetArg ?? 0), outPath);
} else {
  console.error(
    'usage: profile-queries.mjs enable [server.log] | disable | report <server.log> <offset> [out.md]',
  );
  process.exitCode = 2;
}

/* -------------------------------------------------------------- report -- */

function readFrom(path, offset) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The JSON object starting at `start`, by brace matching (strings respected). */
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function scans(node, out = []) {
  const type = node['Node Type'];
  if (/Scan/.test(type) && node['Relation Name']) {
    out.push({
      type,
      relation: node['Relation Name'],
      index: node['Index Name'] ?? null,
      rows: (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1),
      removed: (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 1),
      // An index that leads with propertyId, entered WITHOUT a propertyId
      // condition: Postgres walks the whole index for each lookup. The RLS
      // policy's `bypass OR propertyId = …` can never become an index
      // condition, so a query that leaves the property to RLS (every Prisma
      // relation load does) lands here.
      skipsLead:
        /_propertyId_/.test(node['Index Name'] ?? '') &&
        !/propertyId/.test(node['Index Cond'] ?? node['Recheck Cond'] ?? ''),
      hits: node['Shared Hit Blocks'] ?? 0,
    });
  }
  for (const child of node.Plans ?? []) scans(child, out);
  return out;
}

function report(path, offset, out) {
  const text = readFrom(path, offset);
  const marker = /duration: ([\d.]+) ms\s+plan:\s*\r?\n/g;
  const groups = new Map();
  let parsed = 0;
  for (let m = marker.exec(text); m !== null; m = marker.exec(text)) {
    const start = text.indexOf('{', m.index + m[0].length - 1);
    const json = objectAt(text, start);
    if (json === null) continue;
    let plan;
    try {
      plan = JSON.parse(json);
    } catch {
      continue; // a line interleaved by another backend; skipped, counted below
    }
    parsed += 1;
    const query = String(plan['Query Text'] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^(BEGIN|COMMIT|SET|SELECT set_config)/i.test(query)) continue;
    const g = groups.get(query) ?? {
      query,
      count: 0,
      total: 0,
      max: 0,
      scans: new Map(),
      buffers: 0,
    };
    const ms = Number(m[1]);
    g.count += 1;
    g.total += ms;
    g.max = Math.max(g.max, ms);
    g.buffers += (plan.Plan?.['Shared Hit Blocks'] ?? 0) + (plan.Plan?.['Shared Read Blocks'] ?? 0);
    for (const s of scans(plan.Plan ?? {})) {
      const key = `${s.type} ${s.relation}${s.index ? ` using ${s.index}` : ''}`;
      const prev = g.scans.get(key) ?? { ...s, rows: 0, removed: 0, n: 0 };
      prev.rows += s.rows;
      prev.removed += s.removed;
      prev.n += 1;
      prev.skipsLead = prev.skipsLead || s.skipsLead;
      prev.hitsTotal = (prev.hitsTotal ?? 0) + s.hits;
      g.scans.set(key, prev);
    }
    groups.set(query, g);
  }

  const ranked = [...groups.values()].sort((a, b) => b.total - a.total);
  const lines = [];
  lines.push(
    `Plans parsed: ${String(parsed)}; distinct query shapes: ${String(ranked.length)}.`,
    '',
  );
  lines.push(
    '| # | calls | total ms | mean ms | max ms | buffers/call | scans | query |',
    '|---|---|---|---|---|---|---|---|',
  );
  const flagged = [];
  const skipped = [];
  ranked.forEach((g, i) => {
    const listed = i < 30;
    const scanText = [...g.scans.entries()]
      .map(([key, s]) => {
        const perCall = Math.round((s.rows + s.removed) / s.n);
        const flag = s.type === 'Seq Scan' && perCall > SEQ_SCAN_ROWS;
        if (flag) flagged.push({ rank: i + 1, key, perCall, query: g.query });
        if (s.skipsLead)
          skipped.push({
            rank: i + 1,
            key,
            buffers: Math.round(s.hitsTotal / s.n),
            calls: g.count,
          });
        return `${flag ? '**SEQ** ' : ''}${s.skipsLead ? '**NO-LEAD** ' : ''}${key} (~${String(perCall)} rows read)`;
      })
      .join('<br>');
    if (!listed) return;
    const q = g.query.length > 220 ? `${g.query.slice(0, 220)}…` : g.query;
    lines.push(
      `| ${String(i + 1)} | ${String(g.count)} | ${g.total.toFixed(0)} | ${(g.total / g.count).toFixed(2)} | ${g.max.toFixed(1)} | ${String(Math.round(g.buffers / g.count))} | ${scanText} | \`${q.replace(/\|/g, '\\|')}\` |`,
    );
  });
  lines.push(
    '',
    `Sequential scans reading more than ${String(SEQ_SCAN_ROWS)} rows per call: ${String(flagged.length)}.`,
  );
  for (const f of flagged)
    lines.push(`- #${String(f.rank)}: ${f.key}, ~${String(f.perCall)} rows per call`);
  lines.push(
    '',
    `propertyId-led indexes entered without a propertyId condition (whole-index walk): ${String(skipped.length)}.`,
  );
  for (const f of skipped)
    lines.push(
      `- #${String(f.rank)} (${String(f.calls)} calls): ${f.key}, ~${String(f.buffers)} buffers per call`,
    );

  const body = lines.join('\n');
  if (out) writeFileSync(out, body);
  console.log(body);
}
