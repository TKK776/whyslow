import type { ParsedPlan, PlanNode } from '../parser/types.js';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  /** Stable across releases. Used for suppression and for linking to docs. */
  ruleId: string;
  nodeId: number;
  severity: Severity;
  title: string;
  /** Plain English, with real table names and real numbers already filled in. */
  body: string;
}

export interface Rule {
  id: string;
  /** One line, shown in the rule list. */
  summary: string;
  check(node: PlanNode, plan: ParsedPlan): Finding[] | Finding | null;
}

const KB_PER_BLOCK = 8;

/* ------------------------------------------------------------------ */
/* Formatting helpers shared by rule messages                          */
/* ------------------------------------------------------------------ */

export function fmtRows(n: number | null): string {
  if (n === null) return 'an unknown number of';
  const v = Math.round(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export function fmtMs(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function fmtMb(kb: number): string {
  const mb = kb / 1024;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(kb)} kB`;
}

/**
 * Pull likely column names out of a filter expression so the advice can name
 * them. Deliberately conservative: better to say "the filter" than to name the
 * wrong column and send someone off building a useless index.
 */
export function columnsInExpression(expr: string): string[] {
  const matches = [...expr.matchAll(/\b([a-z_][a-z0-9_]*)\s*(?:::[a-z ]+)?\s*[=<>]/gi)];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of matches) {
    const name = m[1];
    if (!name) continue;
    const lower = name.toLowerCase();
    if (RESERVED.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
  }

  return out;
}

const RESERVED = new Set([
  'and',
  'or',
  'not',
  'null',
  'true',
  'false',
  'case',
  'when',
  'then',
  'else',
  'end',
  'any',
  'all',
]);

function describeColumns(expr: string | undefined): string {
  if (!expr) return 'the filtered columns';
  const cols = columnsInExpression(expr);
  if (cols.length === 0) return 'the filtered columns';
  if (cols.length === 1) return `${cols[0]}`;
  if (cols.length === 2) return `${cols[0]} and ${cols[1]}`;
  return `${cols.slice(0, -1).join(', ')} and ${cols[cols.length - 1]}`;
}

function relationOf(node: PlanNode): string {
  return node.raw['Relation Name'] ?? 'this table';
}

function loopAdjusted(node: PlanNode, key: string): number {
  const raw = node.raw[key];
  return typeof raw === 'number' ? raw * node.loops : 0;
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const seqScanDiscarding: Rule = {
  id: 'seq-scan-discarding',
  summary: 'Sequential scan that reads far more rows than it returns',
  check(node) {
    if (node.raw['Node Type'] !== 'Seq Scan') return null;
    if (node.actualRows === null) return null;

    const removed = loopAdjusted(node, 'Rows Removed by Filter');
    const read = node.actualRows + removed;
    if (read < 50_000) return null;

    if (removed > node.actualRows) {
      const pct = Math.round((removed / read) * 100);
      return {
        ruleId: this.id,
        nodeId: node.id,
        severity: 'high',
        title: 'Missing index',
        body:
          `Read ${fmtRows(read)} rows from ${relationOf(node)} and threw away ` +
          `${fmtRows(removed)} of them, which is ${pct}% wasted work. An index on ` +
          `${describeColumns(node.raw.Filter)} would let Postgres jump straight to ` +
          `the matching rows instead of walking the whole table.`,
      };
    }

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: 'medium',
      title: 'Full table scan',
      body:
        `Scanned all ${fmtRows(read)} rows of ${relationOf(node)}. That is the ` +
        `right choice when the query genuinely needs most of the table, but worth ` +
        `checking whether an index exists for how this query filters or joins.`,
    };
  },
};

const badRowEstimate: Rule = {
  id: 'row-estimate-off',
  summary: 'Planner row estimate off by 10x or more',
  check(node) {
    if (node.estimateFactor === null || node.estimateFactor < 10) return null;
    if (node.actualRows === null) return null;
    if (node.actualRows < 100 && node.plannedRows < 100) return null;

    /**
     * A bad estimate propagates upward: if a scan returns 200x more rows than
     * predicted, every join above it inherits that error. Reporting on all of
     * them buries the one node the user can act on, so only fire where the
     * error originates, meaning no child is already at least as wrong.
     */
    const ownFactor = node.estimateFactor;
    const inherited = node.children.some(
      (child) =>
        child.estimateFactor !== null &&
        child.overEstimated === node.overEstimated &&
        child.estimateFactor >= ownFactor * 0.9,
    );
    if (inherited) return null;

    const factor = Math.round(node.estimateFactor);
    const direction = node.overEstimated ? 'far fewer' : 'far more';

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: node.estimateFactor >= 100 ? 'high' : 'medium',
      title: `Row estimate off by ${factor}x`,
      body:
        `The planner expected ${fmtRows(node.plannedRows)} rows here and got ` +
        `${fmtRows(node.actualRows)}, so ${direction} than it predicted. Bad estimates ` +
        `at this level push Postgres toward the wrong join strategy above it, which is ` +
        `often the real cause of the slowdown rather than this node itself. Run ANALYZE ` +
        `on ${relationOf(node)}; if the estimate stays wrong, raise the statistics ` +
        `target on the columns involved or add extended statistics if two columns are correlated.`,
    };
  },
};

const sortSpilledToDisk: Rule = {
  id: 'sort-spilled',
  summary: 'Sort written to temporary files instead of memory',
  check(node) {
    if (node.raw['Sort Space Type'] !== 'Disk') return null;
    const usedKb =
      typeof node.raw['Sort Space Used'] === 'number' ? node.raw['Sort Space Used'] : 0;

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: 'high',
      title: 'Sort spilled to disk',
      body:
        `This sort needed ${fmtMb(usedKb)} but work_mem was smaller, so it wrote ` +
        `temporary files and read them back. Raising work_mem above ${fmtMb(usedKb)} ` +
        `for this query keeps the sort in memory. Set it per session or per role rather ` +
        `than globally, since work_mem is allocated per sort and a high global value ` +
        `multiplied across concurrent queries can exhaust memory.`,
    };
  },
};

const hashSpilledToBatches: Rule = {
  id: 'hash-batches',
  summary: 'Hash table split into multiple batches',
  check(node) {
    const batches = node.raw['Hash Batches'];
    if (typeof batches !== 'number' || batches <= 1) return null;

    const peakKb =
      typeof node.raw['Peak Memory Usage'] === 'number'
        ? node.raw['Peak Memory Usage']
        : 0;
    const peakNote = peakKb > 0 ? ` Peak memory used was ${fmtMb(peakKb)}.` : '';

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: 'medium',
      title: `Hash split into ${batches} batches`,
      body:
        `The hash table did not fit in work_mem, so Postgres split it into ${batches} ` +
        `batches and spilled most of them to disk.${peakNote} One batch is the goal. ` +
        `Either raise work_mem, or reduce how many rows reach this join by filtering earlier.`,
    };
  },
};

const expensiveNestedLoop: Rule = {
  id: 'nested-loop-hot',
  summary: 'Nested loop running its inner side many times',
  check(node) {
    if (node.raw['Node Type'] !== 'Nested Loop') return null;
    const inner = node.children[1];
    if (!inner || inner.loops < 5000) return null;
    if (inner.inclusiveMs === null) return null;

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: inner.inclusiveMs > 500 ? 'high' : 'low',
      title: `Inner side ran ${fmtRows(inner.loops)} times`,
      body:
        `This nested loop executed its inner side ${fmtRows(inner.loops)} times, ` +
        `costing ${fmtMs(inner.inclusiveMs)} in total. Nested loops are efficient when ` +
        `the inner side is a quick index lookup and the outer side is small. When the ` +
        `outer side is this large, a hash join is usually cheaper, and Postgres picked ` +
        `this plan because it underestimated the outer row count.`,
    };
  },
};

const coldCache: Rule = {
  id: 'cold-cache',
  summary: 'Blocks read from disk rather than served from cache',
  check(node) {
    const read =
      typeof node.raw['Shared Read Blocks'] === 'number'
        ? node.raw['Shared Read Blocks']
        : 0;
    const hit =
      typeof node.raw['Shared Hit Blocks'] === 'number'
        ? node.raw['Shared Hit Blocks']
        : 0;

    if (read < 5000 || read <= hit) return null;

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: 'low',
      title: 'Reading from disk, not cache',
      body:
        `Fetched ${fmtRows(read)} blocks (${fmtMb(read * KB_PER_BLOCK)}) from disk ` +
        `against ${fmtRows(hit)} from shared_buffers. This data is not resident in ` +
        `cache, so the timing here will look very different on a warm run. Time this ` +
        `query twice before drawing conclusions from it.`,
    };
  },
};

const indexWithHeavyFilter: Rule = {
  id: 'index-wrong-columns',
  summary: 'Index scan discarding many rows after fetching them',
  check(node) {
    const type = node.raw['Node Type'] ?? '';
    if (!type.includes('Index Scan')) return null;
    if (node.actualRows === null) return null;

    const removed = loopAdjusted(node, 'Rows Removed by Filter');
    if (removed < 10_000 || removed < node.actualRows) return null;

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: 'medium',
      title: 'Index is on the wrong columns',
      body:
        `The index found ${fmtRows(node.actualRows + removed)} rows, then a filter ` +
        `discarded ${fmtRows(removed)} of them. The index matches part of the query but ` +
        `not the part doing the real narrowing. Adding ${describeColumns(node.raw.Filter)} ` +
        `to the index would let it reject those rows before fetching them from the heap.`,
    };
  },
};

const lossyBitmapScan: Rule = {
  id: 'bitmap-lossy',
  summary: 'Bitmap scan degraded to page level for lack of memory',
  check(node) {
    const lossy =
      typeof node.raw['Lossy Heap Blocks'] === 'number'
        ? node.raw['Lossy Heap Blocks']
        : 0;
    if (lossy <= 0) return null;

    const exact =
      typeof node.raw['Exact Heap Blocks'] === 'number'
        ? node.raw['Exact Heap Blocks']
        : 0;

    return {
      ruleId: this.id,
      nodeId: node.id,
      severity: 'medium',
      title: 'Bitmap scan went lossy',
      body:
        `${fmtRows(lossy)} blocks were tracked at page level rather than row level ` +
        `(against ${fmtRows(exact)} exact), because the bitmap outgrew work_mem. ` +
        `Postgres then had to recheck every row on those pages. Raising work_mem ` +
        `keeps the bitmap exact and removes the recheck.`,
    };
  },
};

export const RULES: Rule[] = [
  seqScanDiscarding,
  badRowEstimate,
  sortSpilledToDisk,
  hashSpilledToBatches,
  expensiveNestedLoop,
  coldCache,
  indexWithHeavyFilter,
  lossyBitmapScan,
];

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Run every rule over every node. Findings come back sorted by severity. */
export function analyze(plan: ParsedPlan): Finding[] {
  const findings: Finding[] = [];

  for (const node of plan.nodes) {
    for (const rule of RULES) {
      const result = rule.check(node, plan);
      if (!result) continue;
      if (Array.isArray(result)) findings.push(...result);
      else findings.push(result);
    }
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.nodeId - b.nodeId,
  );
}

/** Findings grouped by the node they belong to, for rendering inline. */
export function findingsByNode(findings: Finding[]): Map<number, Finding[]> {
  const map = new Map<number, Finding[]>();
  for (const f of findings) {
    const list = map.get(f.nodeId);
    if (list) list.push(f);
    else map.set(f.nodeId, [f]);
  }
  return map;
}
