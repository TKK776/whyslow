/**
 * Turn a bug report into a permanent test fixture.
 *
 *   npm run fixtures:from-issue -- 42
 *   npm run fixtures:from-issue -- 42 --name parallel-hash-anti-join
 *
 * Pulls the plan JSON out of the issue body, validates that the parser can
 * read it, writes it into src/fixtures/, and prints what the parser currently
 * makes of it. From there `npm test -u` locks in the snapshot and the bug can
 * never silently return.
 *
 * Needs GITHUB_TOKEN in the environment for private or rate-limited access.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { analyze } from '../src/diagnostics/rules.js';
import { parsePlan } from '../src/parser/parse.js';
import { PlanParseError } from '../src/parser/types.js';

const REPO = process.env.GITHUB_REPOSITORY ?? 'OWNER/whyslow';
const FIXTURE_DIR = join(import.meta.dirname, '..', 'src', 'fixtures');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const issueNumber = args[0];

  if (!issueNumber || !/^\d+$/.test(issueNumber)) {
    fail('Usage: npm run fixtures:from-issue -- <issue-number> [--name <slug>]');
  }

  const nameFlag = args.indexOf('--name');
  const explicitName = nameFlag >= 0 ? args[nameFlag + 1] : undefined;

  const body = await fetchIssueBody(issueNumber);
  const planText = extractPlan(body);

  let parsed;
  try {
    parsed = parsePlan(planText);
  } catch (error) {
    if (error instanceof PlanParseError) {
      console.error(`\nThe parser rejected this plan: ${error.message}`);
      console.error(`Hint it would show a user: ${error.hint}`);
      console.error('\nSaving it anyway, since a plan we cannot read is exactly');
      console.error('the kind of thing worth having a fixture for.\n');
      writeFixture(explicitName ?? `issue-${issueNumber}-unparseable`, planText);
      return;
    }
    throw error;
  }

  const slug = explicitName ?? suggestName(parsed, issueNumber);
  const path = writeFixture(slug, planText);

  console.log(`\nWrote ${path}`);
  console.log(`\nWhat the parser currently makes of it:\n`);
  for (const node of parsed.nodes) {
    const own = node.exclusiveMs === null ? '—' : `${node.exclusiveMs.toFixed(1)} ms`;
    console.log(
      `${'  '.repeat(node.depth)}${node.label} ${node.target ?? ''}  (${own})`,
    );
  }

  const findings = analyze(parsed);
  console.log(`\n${findings.length} finding(s):`);
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.title} (${f.ruleId})`);
  }

  console.log(
    '\nNext: run `npm run test:update` to record the snapshot, then fix the bug.',
  );
  console.log('The snapshot diff on your fix is the proof it worked.\n');
}

async function fetchIssueBody(issueNumber: string): Promise<string> {
  const url = `https://api.github.com/repos/${REPO}/issues/${issueNumber}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'whyslow-fixture-script',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    fail(
      `GitHub returned ${res.status} for issue #${issueNumber}. ` +
        (res.status === 404
          ? `Check that GITHUB_REPOSITORY is set correctly (currently "${REPO}").`
          : 'Set GITHUB_TOKEN if you are being rate limited.'),
    );
  }

  const data = (await res.json()) as { body?: string };
  if (!data.body) fail(`Issue #${issueNumber} has an empty body.`);
  return data.body;
}

/**
 * The bug template renders the plan in a ```json block. Fall back to hunting
 * for a bare JSON object, since people paste into the wrong field constantly.
 */
function extractPlan(body: string): string {
  const fenced = [...body.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];

  for (const match of fenced) {
    const content = match[1]?.trim();
    if (content && /"Plan"\s*:/.test(content)) return content;
  }

  const start = body.search(/[[{]\s*\n?\s*[[{"]/);
  if (start >= 0) {
    const candidate = body.slice(start).trim();
    if (/"Plan"\s*:/.test(candidate)) return candidate;
  }

  fail(
    'No plan JSON found in that issue body. The report is missing the required ' +
      'field, so comment asking for it rather than guessing.',
  );
}

/** Name the fixture after what makes it interesting, not after the issue. */
function suggestName(
  parsed: ReturnType<typeof parsePlan>,
  issueNumber: string,
): string {
  const parts: string[] = [];

  if (!parsed.timed) parts.push('no-analyze');
  if (parsed.nodes.some((n) => n.raw['Parallel Aware'])) parts.push('parallel');
  if (parsed.nodes.some((n) => n.raw['Sort Space Type'] === 'Disk'))
    parts.push('disk-sort');
  if (parsed.nodes.some((n) => (n.raw['Hash Batches'] as number) > 1))
    parts.push('batched');
  if (parsed.nodes.some((n) => n.loops > 1000)) parts.push('hot-loop');
  if (parsed.nodes.length > 40) parts.push('large');

  const root = parsed.root.label.toLowerCase().replace(/\s+/g, '-');
  parts.unshift(root);

  return `${parts.join('-')}-issue-${issueNumber}`;
}

function writeFixture(slug: string, contents: string): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  let path = join(FIXTURE_DIR, `${safe}.json`);
  let n = 2;
  while (existsSync(path)) {
    path = join(FIXTURE_DIR, `${safe}-${n}.json`);
    n += 1;
  }

  // Reformat so the corpus stays diffable. If it will not reparse, keep it raw.
  let output = contents;
  try {
    output = `${JSON.stringify(JSON.parse(contents), null, 2)}\n`;
  } catch {
    // Leave as-is.
  }

  writeFileSync(path, output, 'utf8');
  return path;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
