import { describe, expect, it } from 'vitest';

import { parsePlan } from '../src/parser/parse.js';
import { PlanParseError } from '../src/parser/types.js';

function plan(node: object, extra: object = {}) {
  return JSON.stringify([{ Plan: node, ...extra }]);
}

describe('loop handling', () => {
  it('multiplies per-loop time by the loop count', () => {
    const parsed = parsePlan(
      plan({
        'Node Type': 'Index Scan',
        'Actual Total Time': 0.02,
        'Actual Rows': 1,
        'Plan Rows': 1,
        'Actual Loops': 50000,
      }),
    );

    // 0.02ms looks trivial until you notice it ran 50,000 times.
    expect(parsed.root.inclusiveMs).toBeCloseTo(1000, 5);
    expect(parsed.root.actualRows).toBe(50000);
  });

  it('multiplies planned rows by loops so the comparison stays fair', () => {
    const parsed = parsePlan(
      plan({
        'Node Type': 'Index Scan',
        'Actual Total Time': 0.01,
        'Actual Rows': 2,
        'Plan Rows': 2,
        'Actual Loops': 100,
      }),
    );

    expect(parsed.root.actualRows).toBe(200);
    expect(parsed.root.plannedRows).toBe(200);
    // A perfect estimate is a factor of 1, which no rule fires on.
    expect(parsed.root.estimateFactor).toBe(1);
  });

  it('treats a missing or zero loop count as one', () => {
    const parsed = parsePlan(
      plan({ 'Node Type': 'Result', 'Actual Total Time': 5, 'Actual Rows': 1 }),
    );
    expect(parsed.root.loops).toBe(1);
    expect(parsed.root.inclusiveMs).toBe(5);
  });
});

describe('exclusive time', () => {
  it('subtracts children from the parent', () => {
    const parsed = parsePlan(
      plan({
        'Node Type': 'Sort',
        'Actual Total Time': 100,
        'Actual Rows': 10,
        'Plan Rows': 10,
        'Actual Loops': 1,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Parent Relationship': 'Outer',
            'Actual Total Time': 70,
            'Actual Rows': 10,
            'Plan Rows': 10,
            'Actual Loops': 1,
          },
        ],
      }),
    );

    expect(parsed.root.exclusiveMs).toBeCloseTo(30, 5);
    expect(parsed.nodes[1]?.exclusiveMs).toBeCloseTo(70, 5);
  });

  it('sums multiple children before subtracting', () => {
    const parsed = parsePlan(
      plan({
        'Node Type': 'Append',
        'Actual Total Time': 100,
        'Actual Loops': 1,
        'Actual Rows': 3,
        'Plan Rows': 3,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Actual Total Time': 40,
            'Actual Loops': 1,
            'Actual Rows': 1,
            'Plan Rows': 1,
          },
          {
            'Node Type': 'Seq Scan',
            'Actual Total Time': 35,
            'Actual Loops': 1,
            'Actual Rows': 1,
            'Plan Rows': 1,
          },
        ],
      }),
    );

    expect(parsed.root.exclusiveMs).toBeCloseTo(25, 5);
  });

  it('clamps at zero rather than showing negative time', () => {
    const parsed = parsePlan(
      plan({
        'Node Type': 'Gather',
        'Actual Total Time': 10,
        'Actual Loops': 1,
        'Actual Rows': 1,
        'Plan Rows': 1,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Actual Total Time': 30,
            'Actual Loops': 1,
            'Actual Rows': 1,
            'Plan Rows': 1,
          },
        ],
      }),
    );

    expect(parsed.root.exclusiveMs).toBe(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

describe('estimate factor', () => {
  it('reports underestimates', () => {
    const parsed = parsePlan(
      plan({
        'Node Type': 'Seq Scan',
        'Actual Total Time': 1,
        'Actual Rows': 10000,
        'Plan Rows': 100,
        'Actual Loops': 1,
      }),
    );
    expect(parsed.root.estimateFactor).toBe(100);
    expect(parsed.root.overEstimated).toBe(false);
  });

  it('reports overestimates', () => {
    const parsed = parsePlan(
      plan({
        'Node Type': 'Seq Scan',
        'Actual Total Time': 1,
        'Actual Rows': 100,
        'Plan Rows': 10000,
        'Actual Loops': 1,
      }),
    );
    expect(parsed.root.estimateFactor).toBe(100);
    expect(parsed.root.overEstimated).toBe(true);
  });
});

describe('input handling', () => {
  it('accepts a bare object root', () => {
    const parsed = parsePlan(
      JSON.stringify({ Plan: { 'Node Type': 'Result' }, 'Planning Time': 1 }),
    );
    expect(parsed.root.label).toBe('Result');
  });

  it('accepts a doubly nested array', () => {
    const parsed = parsePlan(JSON.stringify([[{ Plan: { 'Node Type': 'Result' } }]]));
    expect(parsed.root.label).toBe('Result');
  });

  it('recognises text format and says what to run instead', () => {
    const text = `                             QUERY PLAN
-------------------------------------------------------------
 Seq Scan on orders  (cost=0.00..1834.00 rows=4200 width=84)`;

    expect(() => parsePlan(text)).toThrow(PlanParseError);
    try {
      parsePlan(text);
    } catch (e) {
      expect((e as PlanParseError).hint).toContain('FORMAT JSON');
    }
  });

  it('rejects empty input', () => {
    expect(() => parsePlan('   ')).toThrow(PlanParseError);
  });

  it('rejects JSON without a Plan key', () => {
    expect(() => parsePlan('[{"rows": 4}]')).toThrow(PlanParseError);
  });

  it('rejects an empty array', () => {
    expect(() => parsePlan('[]')).toThrow(PlanParseError);
  });
});

describe('untimed plans', () => {
  it('marks a plan without ANALYZE as untimed', () => {
    const parsed = parsePlan(
      plan({ 'Node Type': 'Seq Scan', 'Total Cost': 100, 'Plan Rows': 40 }),
    );
    expect(parsed.timed).toBe(false);
    expect(parsed.root.exclusiveMs).toBeNull();
    expect(parsed.root.actualRows).toBeNull();
  });
});

describe('labels', () => {
  it('marks parallel nodes', () => {
    const parsed = parsePlan(
      plan({ 'Node Type': 'Seq Scan', 'Parallel Aware': true, 'Actual Loops': 1 }),
    );
    expect(parsed.root.label).toBe('Parallel Seq Scan');
  });

  it('names the aggregate strategy', () => {
    const parsed = parsePlan(
      plan({ 'Node Type': 'Aggregate', Strategy: 'Hashed', 'Actual Loops': 1 }),
    );
    expect(parsed.root.label).toBe('Hashed Aggregate');
  });

  it('leaves inner joins unannotated but names outer joins', () => {
    const inner = parsePlan(
      plan({ 'Node Type': 'Hash Join', 'Join Type': 'Inner', 'Actual Loops': 1 }),
    );
    const left = parsePlan(
      plan({ 'Node Type': 'Hash Join', 'Join Type': 'Left', 'Actual Loops': 1 }),
    );
    expect(inner.root.label).toBe('Hash Join');
    expect(left.root.label).toBe('Hash Join (Left)');
  });
});
