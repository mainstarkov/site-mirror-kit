import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { capture, serve } from '../src/index.js';

const listen = server => new Promise(done => server.listen(0, '127.0.0.1', done));
const close = server => new Promise(done => server.close(done));

test('browser capture replays styles, scripts, JSON, redirects, pages and external assets with source servers offline', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'site-mirror-'));
  const cdn = createServer((req, res) => {
    if (req.url === '/style.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end('body { color: rgb(12, 34, 56); background-image: url("/pixel.svg"); }');
    } else {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
    }
  });
  await listen(cdn);
  const cdnURL = `http://127.0.0.1:${cdn.address().port}`;
  const origin = createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/home?q=1' }); res.end(); }
    else if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end('fetch("/data.json").then(r=>r.json()).then(d=>document.querySelector("#data").textContent=d.value);document.querySelector("button").onclick=()=>document.querySelector("button").textContent="Works";');
    } else if (req.url === '/data.json') { res.setHeader('Content-Type', 'application/json'); res.end('{"value":"Saved JSON"}'); }
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><head><link rel="stylesheet" href="${cdnURL}/style.css"></head><body><h1>Fixture</h1><img src="${cdnURL}/pixel.svg" alt="Test"><button>Click</button><p id="data"></p><a href="/other#section">Next</a><script src="/app.js"></script></body></html>`);
    }
  });
  await listen(origin);
  const originURL = `http://127.0.0.1:${origin.address().port}`;
  let replay, browser;
  try {
    const result = await capture(`${originURL}/start`, join(temporary, 'copy'), { maxPages: 2, waitMs: 100 });
    assert.equal(result.manifest.pages.length, 2);
    assert.equal(result.manifest.errors.length, 0, JSON.stringify(result.manifest.errors));
    assert.ok(Object.keys(result.manifest.resources).some(url => url.endsWith('/pixel.svg')));
    await assert.rejects(capture(originURL, join(temporary, 'copy')), /EEXIST/);
    await close(origin);
    await close(cdn);
    replay = await serve(result.directory, { port: 0 });
    browser = await chromium.launch();
    const page = await browser.newPage();
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto(replay.url);
    await page.waitForFunction(() => document.querySelector('#data').textContent === 'Saved JSON');
    assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).color), 'rgb(12, 34, 56)');
    await page.waitForFunction(() => document.querySelector('img').naturalWidth === 1, null, { timeout: 2000 });
    await page.locator('button').click();
    assert.equal(await page.locator('button').textContent(), 'Works');
    await page.locator('a').click();
    assert.ok(page.url().endsWith('/other#section'));
    assert.ok(requests.every(url => new URL(url).origin === new URL(replay.url).origin));
    assert.equal((await fetch(new URL('/missing', replay.url))).status, 404);
    assert.equal((await fetch(replay.url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(new URL('/start', replay.url), { redirect: 'manual' })).status, 302);
    // A modified manifest cannot read files outside the archive directory.
    const manifestFile = join(result.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile));
    manifest.resources[`${originURL}/escape`] = { status: 200, type: 'text/plain', file: '../secret' };
    await writeFile(join(temporary, 'secret'), 'SECRET');
    await writeFile(manifestFile, JSON.stringify(manifest));
    const malicious = await serve(result.directory, { port: 0 });
    try { assert.equal((await fetch(new URL('/escape', malicious.url))).status, 500); }
    finally { await close(malicious.server); }
  } finally {
    if (browser) await browser.close();
    if (replay) await close(replay.server);
    if (origin.listening) await close(origin);
    if (cdn.listening) await close(cdn);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('reject invalid input before capture', async () => {
  await assert.rejects(capture('file:///etc/passwd', 'unused'), /HTTP/);
  await assert.rejects(capture('https://user:password@example.com', 'unused'), /credentials/);
  await assert.rejects(capture('https://example.com', 'unused', { maxPages: 0 }), /maxPages/);
  await assert.rejects(serve('.', { port: -1 }), /port/);
});
