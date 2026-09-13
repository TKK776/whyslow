import { useCallback, useEffect, useState } from 'react';

import { analyze, findingsByNode, fmtMs, fmtRows } from '../diagnostics/rules.js';
import type { Finding } from '../diagnostics/rules.js';
import { parsePlan } from '../parser/parse.js';
import { PlanParseError, type ParsedPlan, type PlanNode } from '../parser/types.js';
import EXAMPLE from '../fixtures/seq-scan-disk-sort.json';
import {
  ShareTooLargeError,
  decodeFromUrl,
  encodeForUrl,
  isShareSupported,
} from '../share.js';
import { C, MONO, SANS, heat, tint } from './tokens.js';

const EXAMPLE_TEXT = JSON.stringify(EXAMPLE, null, 2);

interface Analysis {
  plan: ParsedPlan;
  findings: Finding[];
  byNode: Map<number, Finding[]>;
  maxExclusive: number;
  total: number;
  slowest: PlanNode | null;
}

function build(plan: ParsedPlan): Analysis {
  const findings = analyze(plan);
  const maxExclusive = plan.nodes.reduce((m, n) => Math.max(m, n.exclusiveMs ?? 0), 0);
  const total = plan.executionTimeMs ?? plan.totalExclusiveMs ?? maxExclusive ?? 1;
  const slowest = plan.nodes.reduce<PlanNode | null>(
    (best, n) => ((n.exclusiveMs ?? 0) > (best?.exclusiveMs ?? -1) ? n : best),
    null,
  );

  return {
    plan,
    findings,
    byNode: findingsByNode(findings),
    maxExclusive,
    total,
    slowest,
  };
}

export default function App() {
  const [text, setText] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [share, setShare] = useState<ShareState>({ kind: 'idle' });

  const read = useCallback((source: string) => {
    try {
      const next = build(parsePlan(source));
      setAnalysis(next);
      setError(null);
      setOpen(new Set(next.slowest ? [next.slowest.id] : []));
      setShare({ kind: 'idle' });
      void writeFragment(source, setShare);
    } catch (e) {
      setAnalysis(null);
      setError(
        e instanceof PlanParseError
          ? { message: e.message, hint: e.hint }
          : { message: 'Something went wrong reading that plan.', hint: String(e) },
      );
    }
  }, []);

  const toggle = useCallback((id: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setAnalysis(null);
    setError(null);
    setText('');
    setShare({ kind: 'idle' });
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  // A shared link carries the plan in the fragment. Read it once on load.
  useEffect(() => {
    if (!window.location.hash || !isShareSupported()) return;
    let cancelled = false;
    void decodeFromUrl(window.location.hash).then((decoded) => {
      if (cancelled || decoded === null) return;
      setText(decoded);
      read(decoded);
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShare({ kind: 'copied' });
      setTimeout(
        () => setShare((s) => (s.kind === 'copied' ? { kind: 'ready' } : s)),
        1800,
      );
    } catch {
      setShare({
        kind: 'failed',
        reason: 'Clipboard access was blocked. Copy the address bar instead.',
      });
    }
  }, []);

  return (
    <div style={S.page}>
      <div style={S.frame}>
        <Header />

        {!analysis && (
          <Input
            text={text}
            onChange={setText}
            onRead={() => read(text)}
            onExample={() => {
              setText(EXAMPLE_TEXT);
              read(EXAMPLE_TEXT);
            }}
          />
        )}

        {error && <ErrorBox message={error.message} hint={error.hint} />}

        {analysis && (
          <Result
            analysis={analysis}
            open={open}
            onToggle={toggle}
            onReset={reset}
            share={share}
            onCopyLink={copyLink}
          />
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <header style={{ marginBottom: 22 }}>
      <h1 style={S.wordmark}>whyslow</h1>
      <p style={S.tagline}>
        Paste a Postgres plan from{' '}
        <code style={S.code}>EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)</code> and see
        which step actually took the time. Nothing leaves your browser.
      </p>
    </header>
  );
}

function Input({
  text,
  onChange,
  onRead,
  onExample,
}: {
  text: string;
  onChange: (v: string) => void;
  onRead: () => void;
  onExample: () => void;
}) {
  const ready = text.trim().length > 0;

  return (
    <div style={S.card}>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'[\n  {\n    "Plan": { ... }\n  }\n]'}
        spellCheck={false}
        aria-label="Query plan JSON"
        style={S.textarea}
      />
      <div style={S.actions}>
        <button onClick={onRead} disabled={!ready} style={S.primary(ready)}>
          Read the plan
        </button>
        <button onClick={onExample} style={S.secondary}>
          Load a slow example
        </button>
      </div>
    </div>
  );
}

function ErrorBox({ message, hint }: { message: string; hint: string }) {
  return (
    <div style={S.error} role="alert">
      <strong style={{ fontWeight: 600 }}>{message}</strong>
      <span style={{ display: 'block', marginTop: 4 }}>{hint}</span>
    </div>
  );
}

function Result({
  analysis,
  open,
  onToggle,
  onReset,
  share,
  onCopyLink,
}: {
  analysis: Analysis;
  open: Set<number>;
  onToggle: (id: number) => void;
  onReset: () => void;
  share: ShareState;
  onCopyLink: () => void;
}) {
  const { plan } = analysis;

  return (
    <>
      {!plan.timed && (
        <div style={S.notice}>
          <strong style={{ fontWeight: 600 }}>This plan has no timings.</strong> It was
          run without ANALYZE, so everything below is the planner&rsquo;s prediction
          rather than what happened. Re-run with{' '}
          <code style={S.code}>EXPLAIN (ANALYZE, ...)</code> for real numbers.
        </div>
      )}

      <div style={S.card}>
        <Summary analysis={analysis} />
        <div style={S.columns}>
          <span>node</span>
          <span>own time</span>
          <span style={{ textAlign: 'right' }}>share</span>
        </div>
        {plan.nodes.map((node) => (
          <Row
            key={node.id}
            node={node}
            analysis={analysis}
            open={open.has(node.id)}
            onToggle={() => onToggle(node.id)}
          />
        ))}
      </div>

      <div style={S.toolbar}>
        <button onClick={onReset} style={S.secondary}>
          Read another plan
        </button>
        <ShareButton share={share} onCopyLink={onCopyLink} />
      </div>
    </>
  );
}

type ShareState =
  | { kind: 'idle' }
  | { kind: 'ready' }
  | { kind: 'copied' }
  | { kind: 'failed'; reason: string };

async function writeFragment(
  source: string,
  setShare: (s: ShareState) => void,
): Promise<void> {
  if (!isShareSupported()) {
    setShare({ kind: 'failed', reason: 'This browser cannot build share links.' });
    return;
  }
  try {
    const fragment = await encodeForUrl(source);
    history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#${fragment}`,
    );
    setShare({ kind: 'ready' });
  } catch (e) {
    if (e instanceof ShareTooLargeError) {
      setShare({ kind: 'failed', reason: 'Too large to share by link.' });
    } else {
      setShare({ kind: 'failed', reason: 'Could not build a share link.' });
    }
  }
}

function ShareButton({
  share,
  onCopyLink,
}: {
  share: ShareState;
  onCopyLink: () => void;
}) {
  if (share.kind === 'idle') return null;

  if (share.kind === 'failed') {
    return (
      <span style={S.shareNote} title={share.reason}>
        {share.reason}
      </span>
    );
  }

  return (
    <button onClick={onCopyLink} style={S.secondary} data-share>
      {share.kind === 'copied' ? 'Link copied' : 'Copy link to this plan'}
    </button>
  );
}

function Summary({ analysis }: { analysis: Analysis }) {
  const { plan, slowest, findings } = analysis;
  const high = findings.filter((f) => f.severity === 'high').length;

  return (
    <div style={S.summary}>
      <div style={{ display: 'flex', gap: 30, flexWrap: 'wrap' }}>
        <Metric label="execution" value={fmtMs(plan.executionTimeMs)} />
        <Metric label="planning" value={fmtMs(plan.planningTimeMs)} />
        <Metric label="nodes" value={String(plan.nodes.length)} />
        {high > 0 && <Metric label="worth fixing" value={String(high)} alert />}
      </div>

      {slowest && slowest.exclusiveMs !== null && (
        <div style={{ maxWidth: 360 }}>
          <div style={S.metricLabel}>slowest step</div>
          <div style={{ fontFamily: MONO, fontSize: 13, color: C.hot }}>
            {slowest.label} {slowest.target ?? ''} · {fmtMs(slowest.exclusiveMs)}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div>
      <div style={S.metricLabel}>{label}</div>
      <div style={{ ...S.metricValue, color: alert ? C.hot : C.ink }}>{value}</div>
    </div>
  );
}

function Row({
  node,
  analysis,
  open,
  onToggle,
}: {
  node: PlanNode;
  analysis: Analysis;
  open: boolean;
  onToggle: () => void;
}) {
  const findings = analysis.byNode.get(node.id) ?? [];
  const own = node.exclusiveMs ?? 0;
  const share = analysis.maxExclusive > 0 ? own / analysis.maxExclusive : 0;
  const pct = analysis.total > 0 ? (own / analysis.total) * 100 : 0;
  const heavy = pct >= 20;
  const color = heat(share);

  return (
    <div style={{ borderBottom: `1px solid ${C.ruleSoft}` }} data-node={node.id}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        data-heavy={heavy}
        style={{
          ...S.row,
          background: heavy ? tint(share) : open ? C.paper : 'transparent',
          borderLeftColor: heavy ? color : 'transparent',
          borderLeftWidth: heavy ? 4 : 3,
        }}
      >
        <span style={{ ...S.rowLabel, paddingLeft: node.depth * 18 }}>
          <span style={{ ...S.nodeType, fontWeight: heavy ? 600 : 500 }}>
            {node.label}
          </span>
          {node.target && <span style={S.nodeTarget}>{node.target}</span>}
          {node.loops > 1 && <span style={S.loopBadge}>×{fmtRows(node.loops)}</span>}
          {findings.length > 0 && (
            <span style={S.findingBadge}>
              {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
            </span>
          )}
        </span>

        <span style={S.barTrack}>
          <span
            style={{
              display: 'block',
              width: `${Math.max(share * 100, own > 0 ? 2 : 0)}%`,
              height: '100%',
              background: color,
            }}
          />
        </span>

        <span
          style={{
            ...S.rowTime,
            fontWeight: heavy ? 700 : 400,
            fontSize: heavy ? 13 : 12,
            color: heavy ? C.ink : C.inkSoft,
          }}
        >
          {node.timed ? fmtMs(own) : '—'}
          {pct >= 1 && <span style={{ color: C.inkFaint }}> {Math.round(pct)}%</span>}
        </span>
      </button>

      {open && (
        <div style={{ ...S.detail, paddingLeft: node.depth * 18 + 17 }}>
          <div style={S.stats}>
            <Stat label="rows out" value={fmtRows(node.actualRows)} />
            <Stat
              label="rows expected"
              value={fmtRows(node.plannedRows)}
              alert={node.estimateFactor !== null && node.estimateFactor >= 10}
            />
            {node.loops > 1 && <Stat label="loops" value={fmtRows(node.loops)} />}
            {node.children.length > 0 && (
              <Stat label="with children" value={fmtMs(node.inclusiveMs)} />
            )}
            <Expression label="filter" value={node.raw.Filter} />
            <Expression label="index cond" value={node.raw['Index Cond']} />
            <Expression label="hash cond" value={node.raw['Hash Cond']} />
            <Expression label="sort key" value={node.raw['Sort Key']?.join(', ')} />
          </div>

          {findings.map((f) => (
            <div key={f.ruleId} style={S.finding} data-finding={f.ruleId}>
              <span
                style={{ ...S.findingBar, background: severityColor(f.severity) }}
              />
              <div>
                <div style={S.findingTitle}>{f.title}</div>
                <p style={S.findingBody}>{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div>
      <div style={S.statLabel}>{label}</div>
      <div
        style={{
          ...S.statValue,
          color: alert ? C.hot : C.ink,
          fontWeight: alert ? 600 : 400,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Expression({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div style={{ maxWidth: 520 }}>
      <div style={S.statLabel}>{label}</div>
      <div style={{ ...S.statValue, wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}

function severityColor(severity: Finding['severity']): string {
  if (severity === 'high') return C.hot;
  if (severity === 'medium') return C.warm;
  return C.cold;
}

/* ------------------------------------------------------------------ */

const S = {
  page: {
    minHeight: '100vh',
    background: C.paper,
    fontFamily: SANS,
    color: C.ink,
    padding: '28px 20px 60px',
  },
  frame: { maxWidth: 960, margin: '0 auto' },
  wordmark: {
    margin: 0,
    fontFamily: MONO,
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: '-0.02em',
  },
  tagline: {
    margin: '6px 0 0',
    fontSize: 14,
    lineHeight: 1.55,
    color: C.inkSoft,
    maxWidth: 620,
  },
  code: { fontFamily: MONO, fontSize: 13 },
  card: {
    background: C.surface,
    border: `1px solid ${C.rule}`,
    borderRadius: 4,
    overflow: 'hidden' as const,
  },
  textarea: {
    width: '100%',
    minHeight: 260,
    padding: 16,
    border: 'none',
    outline: 'none',
    resize: 'vertical' as const,
    fontFamily: MONO,
    fontSize: 12.5,
    lineHeight: 1.6,
    color: C.ink,
    background: 'transparent',
    display: 'block',
    boxSizing: 'border-box' as const,
  },
  actions: {
    display: 'flex',
    gap: 10,
    padding: '12px 16px',
    borderTop: `1px solid ${C.ruleSoft}`,
    background: C.paper,
  },
  primary: (ready: boolean) => ({
    background: ready ? C.accent : C.rule,
    color: ready ? '#fff' : C.inkFaint,
    border: 'none',
    borderRadius: 3,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: SANS,
    cursor: ready ? 'pointer' : 'default',
  }),
  secondary: {
    background: 'transparent',
    color: C.accent,
    border: `1px solid ${C.rule}`,
    borderRadius: 3,
    padding: '8px 14px',
    fontSize: 13,
    fontFamily: SANS,
    cursor: 'pointer',
  },
  error: {
    marginTop: 14,
    padding: '12px 14px',
    background: '#FCEEEC',
    border: '1px solid #F0C9C3',
    borderRadius: 3,
    fontSize: 13,
    lineHeight: 1.55,
    color: '#8C2F26',
  },
  notice: {
    marginBottom: 14,
    padding: '12px 14px',
    background: C.flagBg,
    border: '1px solid #EBD9AE',
    borderRadius: 3,
    fontSize: 13,
    lineHeight: 1.55,
    color: C.flag,
  },
  summary: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 24,
    flexWrap: 'wrap' as const,
    padding: '18px 20px',
    borderBottom: `1px solid ${C.rule}`,
  },
  metricLabel: { fontSize: 11, color: C.inkFaint, marginBottom: 3 },
  metricValue: { fontFamily: MONO, fontSize: 20, letterSpacing: '-0.01em' },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'minmax(200px, 1fr) minmax(160px, 340px) 104px',
    gap: 16,
    padding: '8px 14px',
    borderBottom: `1px solid ${C.rule}`,
    fontSize: 11,
    color: C.inkFaint,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(200px, 1fr) minmax(160px, 340px) 104px',
    gap: 16,
    alignItems: 'center',
    width: '100%',
    padding: '10px 14px',
    border: 'none',
    borderLeft: '3px solid transparent',
    transition: 'background 120ms',
    textAlign: 'left' as const,
    cursor: 'pointer',
    font: 'inherit',
  },
  rowLabel: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  nodeType: {
    fontFamily: MONO,
    fontSize: 13,
    color: C.ink,
    whiteSpace: 'nowrap' as const,
  },
  nodeTarget: { fontFamily: MONO, fontSize: 12, color: C.inkFaint },
  loopBadge: { fontFamily: MONO, fontSize: 11, color: C.inkSoft },
  findingBadge: {
    fontSize: 11,
    color: C.flag,
    background: C.flagBg,
    border: '1px solid #EBD9AE',
    borderRadius: 3,
    padding: '1px 6px',
    whiteSpace: 'nowrap' as const,
  },
  barTrack: {
    display: 'block',
    height: 14,
    background: C.ruleSoft,
    borderRadius: 2,
    overflow: 'hidden' as const,
  },
  rowTime: {
    textAlign: 'right' as const,
    fontFamily: MONO,
    fontSize: 12,
    color: C.inkSoft,
  },
  detail: { padding: '4px 14px 18px', background: C.paper },
  toolbar: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    marginTop: 16,
    flexWrap: 'wrap' as const,
  },
  shareNote: { fontSize: 12, color: C.inkFaint },
  stats: {
    display: 'flex',
    gap: 26,
    flexWrap: 'wrap' as const,
    fontFamily: MONO,
    fontSize: 12,
    marginBottom: 12,
  },
  statLabel: { fontFamily: SANS, fontSize: 11, color: C.inkFaint, marginBottom: 2 },
  statValue: { color: C.ink },
  finding: { display: 'flex', gap: 10, marginTop: 10, maxWidth: 660 },
  findingBar: { display: 'block', width: 3, borderRadius: 2, flexShrink: 0 },
  findingTitle: { fontSize: 13, fontWeight: 600, marginBottom: 3 },
  findingBody: { margin: 0, fontSize: 13, lineHeight: 1.6, color: C.inkSoft },
} as const;
