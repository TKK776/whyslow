import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyze } from '../src/diagnostics/rules.js';
import { parsePlan } from '../src/parser/parse.js';
import type { PlanNode } from '../src/parser/types.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'src', 'fixtures');

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

/**
 * One snapshot per fixture. Every new plan shape encountered in the wild, and
 * every plan attached to a bug report, gets dropped into the fixtures folder
 * and is covered from then on. A regression in the parser or in any rule
 * shows up here across the whole corpus at once.
 */
describe('fixture corpus', () => {
  it('has fixtures to run against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    describe(name, () => {
      const source = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      const plan = parsePlan(source);

      it('parses to a stable shape', () => {
        expect(summarize(plan.nodes)).toMatchSnapshot();
      });

      it('produces stable findings', () => {
        const findings = analyze(plan).map((f) => ({
          rule: f.ruleId,
          node: f.nodeId,
          severity: f.severity,
          title: f.title,
          body: f.body,
        }));
        expect(findings).toMatchSnapshot();
      });

      it('never reports negative time', () => {
        for (const node of plan.nodes) {
          if (node.exclusiveMs !== null) {
            expect(node.exclusiveMs).toBeGreaterThanOrEqual(0);
          }
        }
      });

      it('keeps exclusive time within inclusive time', () => {
        for (const node of plan.nodes) {
          if (node.exclusiveMs === null || node.inclusiveMs === null) continue;
          expect(node.exclusiveMs).toBeLessThanOrEqual(node.inclusiveMs + 0.001);
        }
      });

      it('assigns unique ids in depth-first order', () => {
        const ids = plan.nodes.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
      });
    });
  }
});

/** Snapshot only the derived values. Raw JSON is already in the fixture file. */
function summarize(nodes: PlanNode[]) {
  return nodes.map((n) => ({
    id: n.id,
    depth: n.depth,
    label: n.label,
    target: n.target,
    relationship: n.relationship,
    loops: n.loops,
    timed: n.timed,
    inclusiveMs: round(n.inclusiveMs),
    exclusiveMs: round(n.exclusiveMs),
    actualRows: n.actualRows,
    plannedRows: n.plannedRows,
    estimateFactor: round(n.estimateFactor),
    childCount: n.children.length,
  }));
}

function round(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1000) / 1000;
}
