#!/usr/bin/env node
// Проверяет сгенерированные HTML в изолированном headless Chrome: сеть только к cdnjs.
// Запускать из папки, где установлен playwright-core.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    dir: { type: 'string' },
    prompts: { type: 'string' },
    only: { type: 'string' },
    settle: { type: 'string', default: '6000' },
  },
});
if (!opts.dir) {
  console.error('Использование: node check_scene.mjs --dir <папка с HTML> [--prompts файл] [--only подстрока] [--settle мс]');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright-core'));
} catch {
  console.error('playwright-core не найден в текущей папке. Выполните: npm i playwright-core');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsFile = opts.prompts ?? path.join(here, '..', 'assets', 'prompts.json');
const checks = Object.fromEntries(
  JSON.parse(fs.readFileSync(promptsFile, 'utf8')).prompts.map((p) => [p.name, p.check ?? {}]),
);
const dir = path.resolve(opts.dir);
const settle = Number(opts.settle);
const VIEW = { width: 1280, height: 720 };
const EPS = 1e-3;
const BLANK_STD = 6;
const ROOM_TOLERANCE = 1.5;

const ALLOWED = ['file:', 'data:', 'blob:', 'https://cdnjs.cloudflare.com/'];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

// Копия страницы с доступом к камере: глобальная переменная модуля снаружи не видна.
function withProbe(file, tmp) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.search(/<script[^>]*type=["']module["'][^>]*>/i);
  const end = start < 0 ? -1 : src.indexOf('</script>', start);
  if (end < 0) return file;
  const probe = '\n;try{window.__probe={camera}}catch(e){try{window.__probe={camera:cam}}catch(e2){}}\n';
  const copy = path.join(tmp, path.basename(file));
  fs.writeFileSync(copy, src.slice(0, end) + probe + src.slice(end));
  return copy;
}

const delta = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : null);
const round = (v, digits = 2) => (v == null ? null : Number(v.toFixed(digits)));

function imageStats(helper, png) {
  return helper.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const canvas = new OffscreenCanvas(img.width, img.height);
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    const luma = (x, y, w, h) => {
      const d = g.getImageData(x, y, w, h).data;
      let sum = 0;
      let sq = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l;
        sq += l * l;
      }
      return { mean: sum / n, std: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) };
    };
    // Центр кадра, чтобы панели интерфейса в углах не маскировали пустую сцену.
    const center = luma(img.width >> 2, img.height >> 2, img.width >> 1, img.height >> 1);
    return { mean: luma(0, 0, img.width, img.height).mean, centerStd: center.std };
  }, png.toString('base64'));
}

async function testScene(browser, helper, tmp, file) {
  const name = file.replace(/\.html$/, '');
  const base = name.replace(/\.s\d+(-fixed)?$/, '');
  const check = checks[base] ?? {};
  const result = { name, errors: [], blocked: [] };
  const ctx = await browser.newContext({ viewport: VIEW });
  const page = await ctx.newPage();

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (ALLOWED.some((a) => url.startsWith(a))) return route.continue();
    result.blocked.push(url);
    return route.abort();
  });
  page.on('pageerror', (e) => result.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('net::ERR_FAILED')) result.errors.push('console: ' + m.text());
  });

  const shot = (label) => page.screenshot({ path: path.join(dir, `${name}.${label}.png`) });
  const wait = (ms) => page.waitForTimeout(ms);
  const readCam = () => page.evaluate(() => {
    const c = window.__probe?.camera;
    return c?.position && c?.quaternion ? [...c.position.toArray(), ...c.quaternion.toArray()] : null;
  });
  const drag = async (dx, dy) => {
    await page.mouse.move(VIEW.width / 2, 320);
    await page.mouse.down();
    await page.mouse.move(VIEW.width / 2 + dx, 320 + dy, { steps: 15 });
    await page.mouse.up();
    await wait(2000);
  };

  try {
    await page.goto(pathToFileURL(withProbe(path.join(dir, file), tmp)).href, { waitUntil: 'load', timeout: 30000 });
    await wait(settle);
    const cam0 = await readCam();
    const start = await shot('start');
    await wait(1500);
    const cam1 = await readCam();
    const idle = await shot('idle');
    const idleStats = await imageStats(helper, idle);
    const isStatic = start.equals(idle);
    const idleMoved = delta(cam0, cam1) > EPS;

    result.camera_hook = cam1 !== null;
    result.static_when_idle = isStatic;
    result.canvas = await page.evaluate(() => Boolean(document.querySelector('canvas')));
    result.center_std = round(idleStats.centerStd);
    result.mean_luma = round(idleStats.mean);
    result.buttons = await page.$$eval('button', (b) => b.map((x) => x.innerText.trim()).filter(Boolean));

    const broken = result.errors.length > 0 || !result.canvas || idleStats.centerStd < BLANK_STD;
    if (broken) {
      result.orbit = 'skipped';
    } else {
      if (check.button) {
        const button = page.locator('button', { hasText: new RegExp(check.button, 'i') }).first();
        if (!(await button.count())) {
          result.button = { found: false };
        } else {
          try {
            const before = idleStats.mean;
            await button.click({ timeout: 3000 });
            await wait(2000);
            const after = await imageStats(helper, await shot('button'));
            result.button = { found: true, clicked: true, luma_before: round(before), luma_after: round(after.mean) };
            await button.click({ timeout: 3000 });
            await wait(1500);
          } catch (e) {
            result.button = { found: true, clicked: false, reason: e.message.split('\n')[0] };
          }
        }
      }

      if (check.walk) {
        await page.mouse.click(VIEW.width / 2, 400);
        await wait(300);
        const beforeLook = await readCam();
        const lookBefore = await shot('before-look');
        await drag(220, 0);
        const lookAfter = await shot('look');
        const lookDelta = delta(beforeLook, await readCam());
        result.look = lookDelta == null ? !lookBefore.equals(lookAfter) : lookDelta > EPS;

        const samples = [];
        const sample = async () => { const c = await readCam(); if (c) samples.push(c); };
        const hold = async (key, ms) => {
          await page.keyboard.down(key);
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { await sample(); await wait(200); }
          await page.keyboard.up(key);
          await wait(300);
        };
        await hold('w', 8000);
        const walked = await shot('walk');
        for (const [key, ms] of [['s', 16000], ['w', 8000], ['a', 8000], ['d', 16000], ['a', 8000]]) await hold(key, ms);
        const endStats = await imageStats(helper, await shot('walk-end'));
        const walk = { pixels_changed: !lookAfter.equals(walked), end_center_std: round(endStats.centerStd) };
        if (samples.length) {
          const span = (i) => Math.max(...samples.map((s) => s[i])) - Math.min(...samples.map((s) => s[i]));
          walk.span = [round(span(0)), round(span(2))];
          walk.moved = Math.max(...walk.span) > 0.5;
          if (check.room) {
            const [a, b] = [...walk.span].sort((x, y) => x - y);
            const [ra, rb] = [...check.room].sort((x, y) => x - y);
            walk.room = check.room;
            walk.stayed_inside = a <= ra + ROOM_TOLERANCE && b <= rb + ROOM_TOLERANCE;
          }
        } else {
          walk.span = null;
          walk.moved = null;
          walk.stayed_inside = null;
        }
        result.walk = walk;
      } else {
        const camBefore = await readCam();
        await drag(300, 40);
        const dragged = await shot('drag');
        const dragDelta = delta(camBefore, await readCam());
        await page.mouse.move(VIEW.width / 2, 360);
        const camBeforeWheel = await readCam();
        await page.mouse.wheel(0, 500);
        await wait(2000);
        const zoomed = await shot('zoom');
        const wheelDelta = delta(camBeforeWheel, await readCam());

        if (result.camera_hook) {
          result.orbit = idleMoved ? 'ambiguous_auto_camera' : dragDelta > EPS ? 'confirmed' : 'no_response';
          result.zoom = idleMoved ? null : wheelDelta > EPS;
        } else if (isStatic) {
          result.orbit = idle.equals(dragged) ? 'no_response' : 'confirmed';
          result.zoom = !dragged.equals(zoomed);
        } else {
          result.orbit = 'ambiguous_animated';
          result.zoom = null;
        }
      }
    }
  } catch (e) {
    result.harness_error = e.message.split('\n')[0];
  }

  result.errors = result.errors.slice(0, 8);
  result.blocked = result.blocked.slice(0, 8);
  result.verdict = result.harness_error ? 'harness_error'
    : result.errors.length ? 'runtime_error'
    : !result.canvas ? 'no_canvas'
    : result.center_std < BLANK_STD ? 'blank'
    : 'runs';
  await ctx.close();
  return result;
}

const executablePath = findChrome();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'threejs-eval-'));
const helper = await browser.newPage();
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && (!opts.only || f.includes(opts.only)));

const lines = [];
for (const file of files) {
  const r = await testScene(browser, helper, tmp, file);
  lines.push(JSON.stringify(r));
  console.log(lines.at(-1));
}
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

const target = path.join(dir, 'check.jsonl');
const previous = fs.existsSync(target) && opts.only
  ? fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).filter((l) => !JSON.parse(l).name.includes(opts.only))
  : [];
fs.writeFileSync(target, [...previous, ...lines].join('\n') + '\n');
