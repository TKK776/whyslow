/**
 * Shapes coming out of `EXPLAIN (FORMAT JSON)`.
 *
 * Every field is optional. Postgres 13 through 18 disagree about which keys
 * appear, and a plan run without ANALYZE or BUFFERS omits whole groups of
 * them. Anything that reads these must default rather than assume.
 */
export interface RawPlanNode {
  'Node Type'?: string;
  'Parent Relationship'?: string;
  'Parallel Aware'?: boolean;
  'Async Capable'?: boolean;
  'Join Type'?: string;
  Strategy?: string;
  'Partial Mode'?: string;
  Operation?: string;

  'Relation Name'?: string;
  Alias?: string;
  'Index Name'?: string;
  'Scan Direction'?: string;
  'CTE Name'?: string;
  'Subplan Name'?: string;
  'Function Name'?: string;

  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;

  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;

  Filter?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  'Hash Cond'?: string;
  'Join Filter'?: string;
  'Merge Cond'?: string;
  'TID Cond'?: string;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Rows Removed by Join Filter'?: number;
  'Heap Fetches'?: number;
  'Exact Heap Blocks'?: number;
  'Lossy Heap Blocks'?: number;

  'Sort Key'?: string[];
  'Sort Method'?: string;
  'Sort Space Used'?: number;
  'Sort Space Type'?: 'Memory' | 'Disk' | string;

  'Hash Buckets'?: number;
  'Original Hash Buckets'?: number;
  'Hash Batches'?: number;
  'Original Hash Batches'?: number;
  'Peak Memory Usage'?: number;

  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Shared Dirtied Blocks'?: number;
  'Shared Written Blocks'?: number;
  'Local Hit Blocks'?: number;
  'Local Read Blocks'?: number;
  'Temp Read Blocks'?: number;
  'Temp Written Blocks'?: number;
  'I/O Read Time'?: number;
  'I/O Write Time'?: number;

  'Workers Planned'?: number;
  'Workers Launched'?: number;
  Workers?: RawWorker[];

  Plans?: RawPlanNode[];

  [key: string]: unknown;
}

export interface RawWorker {
  'Worker Number'?: number;
  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  [key: string]: unknown;
}

export interface RawExplainRoot {
  Plan?: RawPlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
  'Query Text'?: string;
  Triggers?: RawTrigger[];
  JIT?: RawJit;
  Settings?: Record<string, string>;
  [key: string]: unknown;
}

export interface RawTrigger {
  'Trigger Name'?: string;
  Relation?: string;
  Time?: number;
  Calls?: number;
}

export interface RawJit {
  Functions?: number;
  Timing?: Record<string, number>;
  [key: string]: unknown;
}

/** A node after parsing: loop-adjusted, with children resolved. */
export interface PlanNode {
  /** Stable within a single parse, assigned in depth-first order. */
  id: number;
  depth: number;
  /** How this node hangs off its parent: Outer, Inner, InitPlan, SubPlan, Member. */
  relationship: string | null;
  raw: RawPlanNode;
  children: PlanNode[];
  parent: PlanNode | null;

  /** False when the plan was produced without ANALYZE, so timings are absent. */
  timed: boolean;
  loops: number;

  /** Total time including children, multiplied out across loops. Null if untimed. */
  inclusiveMs: number | null;
  /** Time this node spent on its own work. Null if untimed. Never negative. */
  exclusiveMs: number | null;

  /** Loop-adjusted row counts. actualRows is null if untimed. */
  actualRows: number | null;
  plannedRows: number;
  /** How badly the planner missed, as a ratio >= 1. Null when not comparable. */
  estimateFactor: number | null;
  /** True when the planner overestimated rather than underestimated. */
  overEstimated: boolean;

  /** Display strings, computed once. */
  label: string;
  target: string | null;
}

export interface ParsedPlan {
  root: PlanNode;
  /** Every node, depth-first. Same order the tree renders in. */
  nodes: PlanNode[];
  timed: boolean;
  planningTimeMs: number | null;
  executionTimeMs: number | null;
  /** Sum of exclusive time across all nodes. Falls back when Execution Time is absent. */
  totalExclusiveMs: number;
  triggers: RawTrigger[];
  queryText: string | null;
  settings: Record<string, string> | null;
  /** Postgres version cannot be read from the plan, so anything version-shaped is a guess. */
  warnings: string[];
}

export class PlanParseError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'PlanParseError';
    this.hint = hint;
  }
}
