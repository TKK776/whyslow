/**
 * Generate the launch assets from the real UI.
 *
 *   npm run build && npm run shots
 *
 * The README hero image is the one asset a Show HN post lives or dies on, so
 * it is generated rather than hand-cropped. That means it can never drift out
 * of sync with the interface, and it can be regenerated in a second at 2am the
 * night before launching when the design changes.
 *
 * Produces:
 *   docs/hero.png        the before-and-after split for the README
 *   docs/finding.png     a close crop of one finding, for social cards
 *   docs/frames/*.png    frames for the demo GIF
 *
 * Turn the frames into a GIF with:
 *   ffmpeg -framerate 6 -i docs/frames/%03d.png -vf "scale=900:-1:flags=lanczos" docs/demo.gif
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { chromium, type Page } from '@playwright/test';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const DOCS = join(ROOT, 'docs');
const FRAMES = join(DOCS, 'frames');
const PORT = 4319;

/** The plan the hero image shows. Chosen because every rule it triggers is one
 *  a reader will recognise from their own database. */
const HERO_FIXTURE = 'seq-scan-disk-sort.json';

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('\nNo build found. Run `npm run build` first.\n');
    process.exit(1);
  }

  mkdirSync(DOCS, { recursive: true });
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const server = await serveDist();
  const browser = await chromium.launch();

  try {
    const plan = readFileSync(join(ROOT, 'src', 'fixtures', HERO_FIXTURE), 'utf8');

    await captureHero(browser, plan);
    await captureFinding(browser, plan);
    await captureFrames(browser, plan);

    console.log('\nWrote docs/hero.png, docs/finding.png and docs/frames/');
    console.log('For the GIF:');
    console.log('  ffmpeg -y -framerate 6 -i docs/frames/%03d.png \\');
    console.log(
      '    -vf "scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \\',
    );
    console.log('    docs/demo.gif\n');
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * The hero is a split: the wall of text on the left, the read version on the
 * right. Test it at thumbnail width before shipping. If the red bar is not
 * obvious at 400px wide, it will not work as a Reddit or Twitter preview.
 */
async function captureHero(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  plan: string,
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 860 },
    deviceScaleFactor: 2,
  });

  await loadPlan(page, plan);
  await page.screenshot({ path: join(DOCS, 'hero.png') });
  await page.close();

  console.log('  hero.png');
}

/** A close crop of a single finding, which is what makes the tool different
 *  from every other plan viewer. Good for the social card. */
async function captureFinding(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  plan: string,
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 600 },
    deviceScaleFactor: 2,
  });

  await loadPlan(page, plan);

  const finding = page.locator('[data-finding]').first();
  if ((await finding.count()) > 0) {
    await finding.screenshot({ path: join(DOCS, 'finding.png') });
    console.log('  finding.png');
  } else {
    console.log('  finding.png skipped: no [data-finding] element rendered');
  }

  await page.close();
}

/** Eight seconds, no longer. Paste, read, expand, understand. */
async function captureFrames(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  plan: string,
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 760 },
    deviceScaleFactor: 1,
  });

  let frame = 0;
  const shot = async (holdFrames = 1): Promise<void> => {
    for (let i = 0; i < holdFrames; i += 1) {
      await page.screenshot({
        path: join(FRAMES, `${String(frame).padStart(3, '0')}.png`),
      });
      frame += 1;
    }
  };

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('textarea');
  await shot(3);

  // Type a truncated version so the motion reads as pasting, not as a cut.
  await page.locator('textarea').fill(plan.slice(0, 400));
  await shot(2);
  await page.locator('textarea').fill(plan);
  await shot(2);

  await page.getByRole('button', { name: /read the plan/i }).click();
  await page.waitForSelector('[data-node]');
  await shot(5);

  const slowest = page.locator('[data-heavy="true"]').first();
  if ((await slowest.count()) > 0) {
    await slowest.click();
    await page.waitForTimeout(120);
    await shot(8);
  }

  await page.close();
  console.log(`  ${frame} frames`);
}

async function loadPlan(page: Page, plan: string): Promise<void> {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('textarea');
  await page.locator('textarea').fill(plan);
  await page.getByRole('button', { name: /read the plan/i }).click();
  await page.waitForSelector('[data-node]');
  await page.waitForTimeout(200);
}

/** Serve dist without adding a dependency just for this. */
function serveDist(): Promise<ReturnType<typeof createServer>> {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.map': 'application/json',
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
    const path = join(DIST, rel);

    if (!path.startsWith(DIST) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }

    const ext = rel.slice(rel.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(path));
  });

  return new Promise((resolve) => {
    server.listen(PORT, () => resolve(server));
  });
}

/** Reported so CI logs show which Chromium produced the images. */
function logChromiumVersion(): void {
  try {
    const out = execFileSync('npx', ['playwright', '--version'], { encoding: 'utf8' });
    console.log(out.trim());
  } catch {
    // Not important enough to fail on.
  }
}

logChromiumVersion();
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
