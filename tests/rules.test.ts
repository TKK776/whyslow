import { describe, expect, it } from 'vitest';

import { RULES, analyze, columnsInExpression } from '../src/diagnostics/rules.js';
import { parsePlan } from '../src/parser/parse.js';

function analyzeNode(node: object) {
  return analyze(parsePlan(JSON.stringify([{ Plan: node, 'Execution Time': 100 }])));
}

function ids(node: object) {
  return analyzeNode(node).map((f) => f.ruleId);
}

describe('rule registry', () => {
  it('has unique rule ids', () => {
    const seen = RULES.map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('gives every rule a summary', () => {
    for (const rule of RULES) {
      expect(rule.summary.length).toBeGreaterThan(10);
    }
  });
});

describe('seq-scan-discarding', () => {
  it('fires when most rows are thrown away', () => {
    expect(
      ids({
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        'Actual Total Time': 900,
        'Actual Rows': 1000,
        'Plan Rows': 1000,
        'Actual Loops': 1,
        Filter: "(status = 'shipped'::text)",
        'Rows Removed by Filter': 900000,
      }),
    ).toContain('seq-scan-discarding');
  });

  it('stays quiet on a small table', () => {
    expect(
      ids({
        'Node Type': 'Seq Scan',
        'Relation Name': 'countries',
        'Actual Total Time': 1,
        'Actual Rows': 20,
        'Plan Rows': 20,
        'Actual Loops': 1,
        'Rows Removed by Filter': 180,
      }),
    ).not.toContain('seq-scan-discarding');
  });

  it('names the filtered column in the advice', () => {
    const findings = analyzeNode({
      'Node Type': 'Seq Scan',
      'Relation Name': 'orders',
      'Actual Total Time': 900,
      'Actual Rows': 1000,
      'Plan Rows': 1000,
      'Actual Loops': 1,
      Filter: "(status = 'shipped'::text)",
      'Rows Removed by Filter': 900000,
    });
    expect(findings[0]?.body).toContain('status');
    expect(findings[0]?.body).toContain('orders');
  });
});

describe('row-estimate-off', () => {
  it('fires at 10x', () => {
    expect(
      ids({
        'Node Type': 'Seq Scan',
        'Relation Name': 'events',
        'Actual Total Time': 10,
        'Actual Rows': 10000,
        'Plan Rows': 1000,
        'Actual Loops': 1,
      }),
    ).toContain('row-estimate-off');
  });

  it('stays quiet under 10x', () => {
    expect(
      ids({
        'Node Type': 'Seq Scan',
        'Relation Name': 'events',
        'Actual Total Time': 10,
        'Actual Rows': 5000,
        'Plan Rows': 1000,
        'Actual Loops': 1,
      }),
    ).not.toContain('row-estimate-off');
  });

  it('ignores tiny row counts where a big ratio means nothing', () => {
    expect(
      ids({
        'Node Type': 'Seq Scan',
        'Actual Total Time': 1,
        'Actual Rows': 50,
        'Plan Rows': 1,
        'Actual Loops': 1,
      }),
    ).not.toContain('row-estimate-off');
  });
});

describe('sort-spilled', () => {
  it('fires on a disk sort and states the size', () => {
    const findings = analyzeNode({
      'Node Type': 'Sort',
      'Actual Total Time': 500,
      'Actual Rows': 100000,
      'Plan Rows': 100000,
      'Actual Loops': 1,
      'Sort Method': 'external merge',
      'Sort Space Used': 41216,
      'Sort Space Type': 'Disk',
    });
    expect(findings.map((f) => f.ruleId)).toContain('sort-spilled');
    expect(findings.find((f) => f.ruleId === 'sort-spilled')?.body).toContain('40 MB');
  });

  it('stays quiet on an in-memory sort', () => {
    expect(
      ids({
        'Node Type': 'Sort',
        'Actual Total Time': 5,
        'Actual Rows': 100,
        'Plan Rows': 100,
        'Actual Loops': 1,
        'Sort Space Type': 'Memory',
        'Sort Space Used': 64,
      }),
    ).not.toContain('sort-spilled');
  });
});

describe('hash-batches', () => {
  it('fires above one batch', () => {
    expect(
      ids({
        'Node Type': 'Hash',
        'Actual Total Time': 100,
        'Actual Rows': 1000,
        'Plan Rows': 1000,
        'Actual Loops': 1,
        'Hash Batches': 16,
      }),
    ).toContain('hash-batches');
  });

  it('stays quiet at one batch', () => {
    expect(
      ids({
        'Node Type': 'Hash',
        'Actual Total Time': 100,
        'Actual Rows': 1000,
        'Plan Rows': 1000,
        'Actual Loops': 1,
        'Hash Batches': 1,
      }),
    ).not.toContain('hash-batches');
  });
});

describe('healthy plans stay silent', () => {
  it('produces no findings for a fast index lookup', () => {
    expect(
      analyzeNode({
        'Node Type': 'Index Scan',
        'Relation Name': 'users',
        'Index Name': 'users_pkey',
        'Actual Total Time': 0.04,
        'Actual Rows': 1,
        'Plan Rows': 1,
        'Actual Loops': 1,
        'Shared Hit Blocks': 4,
      }),
    ).toEqual([]);
  });
});

describe('column extraction', () => {
  it('pulls names out of a compound filter', () => {
    expect(
      columnsInExpression(
        "((status = 'shipped'::text) AND (placed_at > '2026-01-01'::date))",
      ),
    ).toEqual(['status', 'placed_at']);
  });

  it('skips SQL keywords', () => {
    expect(columnsInExpression('(a = 1 AND b = 2)')).toEqual(['a', 'b']);
  });

  it('returns nothing it cannot read', () => {
    expect(columnsInExpression('complicated_function(x)')).toEqual([]);
  });
});

describe('finding order', () => {
  it('puts high severity first', () => {
    const findings = analyzeNode({
      'Node Type': 'Sort',
      'Actual Total Time': 900,
      'Actual Rows': 100000,
      'Plan Rows': 100000,
      'Actual Loops': 1,
      'Sort Space Type': 'Disk',
      'Sort Space Used': 40000,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'big',
          'Actual Total Time': 400,
          'Actual Rows': 100000,
          'Plan Rows': 100000,
          'Actual Loops': 1,
          'Shared Read Blocks': 60000,
          'Shared Hit Blocks': 100,
        },
      ],
    });

    // Alphabetical sort would put "low" before "medium", so rank explicitly.
    const rank = { high: 0, medium: 1, low: 2 };
    const severities = findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => rank[a] - rank[b]));
    expect(severities[0]).toBe('high');
  });
});
