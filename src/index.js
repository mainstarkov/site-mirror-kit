import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { createServer } from 'node:http';

function webURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP(S) URL without embedded credentials.');
  }
  url.hash = '';
  return url;
}

/** Capture public browser requests. Existing directories are never overwritten. */
export async function capture(url, directory, { maxPages = 1, waitMs = 1500, channel, onProgress = () => {} } = {}) {
  const start = webURL(url);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('maxPages must be 1–100.');
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new Error('waitMs must be 0–30000.');
  const output = resolve(directory);
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  let context;
  try {
    await mkdir(output); // Refuse existing targets, including symlinks.
    await mkdir(join(output, 'files'));
    await mkdir(join(output, 'snapshots'));
    context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    const manifest = { version: 1, entry: start.href, created: new Date().toISOString(), resources: {}, pages: [], errors: [] };
    const pending = new Set();
    let bytes = 0;
    // shortcut: 100 MB per response and 500 MB total; use a streaming archiver for large media sites.
    const resourceLimit = 100 * 1024 * 1024;
    const totalLimit = 500 * 1024 * 1024;
    await context.route('**/*', route => {
      if (!['GET', 'HEAD'].includes(route.request().method())) return route.abort();
      return route.continue();
    });
    context.on('response', response => {
      const task = (async () => {
        const request = response.request();
        if (request.method() !== 'GET') return;
        const key = webURL(response.url()).href;
        if (manifest.resources[key]) return;
        const headers = response.headers();
        if (Number(headers['content-length']) > resourceLimit) throw new Error('Resource exceeds 100 MB');
        const status = response.status();
        if (status >= 400) manifest.errors.push({ url: key, message: `HTTP ${status}` });
        if (status >= 300 && status < 400 && headers.location) {
          manifest.resources[key] = { status, location: new URL(headers.location, key).href };
          return;
        }
        const body = await response.body();
        if (body.length > resourceLimit || bytes + body.length > totalLimit) throw new Error('Archive size limit exceeded');
        bytes += body.length;
        const extension = extname(new URL(key).pathname).match(/^\.[a-zA-Z0-9]{1,8}$/)?.[0] || '.bin';
        const file = `files/${createHash('sha256').update(key).digest('hex')}${extension}`;
        await writeFile(join(output, file), body);
        manifest.resources[key] = { status, type: headers['content-type'] || 'application/octet-stream', file, bytes: body.length };
      })().catch(error => manifest.errors.push({ url: response.url(), message: error.message }));
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
    const page = await context.newPage();
    page.on('requestfailed', request => manifest.errors.push({ url: request.url(), message: request.failure()?.errorText }));
    const queue = [start.href];
    const seen = new Set();
    let crawlOrigin = start.origin;
    while (queue.length && seen.size < maxPages) {
      const next = queue.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      onProgress(`Capture ${seen.size}/${maxPages}: ${next}`);
      try {
        const response = await page.goto(next, { waitUntil: 'load', timeout: 30000 });
        if (!response || response.status() >= 400) throw new Error(`Page returned HTTP ${response?.status()}`);
        if (manifest.pages.length === 0) {
          manifest.entry = webURL(page.url()).href;
          crawlOrigin = new URL(manifest.entry).origin;
        }
        // Bounded scrolling triggers common lazy images without clicking or submitting forms.
        await page.evaluate(async () => {
          for (let step = 0; step < 12; step++) {
            window.scrollBy(0, window.innerHeight);
            await new Promise(done => setTimeout(done, 100));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(waitMs);
        await writeFile(join(output, 'snapshots', `${seen.size}.html`), await page.content());
        manifest.pages.push(page.url());
        const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.href));
        for (const link of links) {
          try {
            const target = webURL(link);
            if (target.origin === crawlOrigin && !seen.has(target.href) && !queue.includes(target.href) && queue.length < 1000) queue.push(target.href);
          } catch { /* Non-web links are not crawl targets. */ }
        }
      } catch (error) {
        manifest.errors.push({ url: next, message: error.message });
      }
    }
    await page.close();
    while (pending.size) await Promise.all([...pending]);
    await context.close();
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (!manifest.pages.length) throw new Error(`No pages captured. See ${join(output, 'manifest.json')}`);
    return { directory: output, manifest };
  } finally {
    await browser.close();
  }
}

function localURL(value, entry) {
  const hash = new URL(value).hash;
  const target = webURL(value);
  return target.origin === entry.origin
    ? `${target.pathname}${target.search}${hash}`
    : `/_mirror/${Buffer.from(target.origin).toString('base64url')}${target.pathname}${target.search}${hash}`;
}

function rewrite(body, source, entry, type) {
  let text = body.toString('utf8');
  if (source.origin !== entry.origin) {
    const prefix = `/_mirror/${Buffer.from(source.origin).toString('base64url')}`;
    text = text.replace(/(["'(=]\s*)\/(?!\/|_mirror\/)/g, `$1${prefix}/`);
  }
  // shortcut: textual URL rewriting cannot cover computed/obfuscated URLs; missing requests return 404.
  text = text.replace(/https?:\/\/[^\s<>"'`\\)]+/g, value => {
    if (/^https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xhtml|1999\/xlink|XML\/1998\/namespace)$/.test(value)) return value;
    try { return localURL(value, entry); } catch { return value; }
  });
  text = text.replace(/(["'(=]\s*)\/\/([a-zA-Z0-9][^\s<>"'`)]+)/g, (_, lead, value) => {
    try { return lead + localURL(`${source.protocol}//${value}`, entry); } catch { return lead + '//' + value; }
  });
  if (/html/i.test(type)) {
    text = text.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy\b[^>]*>/gi, '');
    text = text.replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
  }
  return text;
}

/** Serve only recorded files on loopback. No proxying to the live website. */
export async function serve(directory, { port = 4173 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const root = await realpath(resolve(directory));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !manifest.resources) throw new Error('Unsupported archive.');
  const entry = webURL(manifest.entry);
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'self'; worker-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end('Read-only archive'); return; }
    try {
      const incoming = new URL(req.url, 'http://localhost');
      let source;
      if (incoming.pathname.startsWith('/_mirror/')) {
        const parts = incoming.pathname.slice('/_mirror/'.length).split('/');
        const origin = webURL(Buffer.from(parts.shift(), 'base64url').toString()).origin;
        source = webURL(`${origin}/${parts.join('/')}${incoming.search}`);
      } else {
        source = webURL(`${entry.origin}${incoming.pathname}${incoming.search}`);
      }
      const resource = manifest.resources[source.href];
      if (!resource) { res.writeHead(404); res.end('Not captured: ' + source.href); return; }
      if (resource.location) { res.writeHead(resource.status, { Location: localURL(resource.location, entry) }); res.end(); return; }
      const path = await realpath(resolve(root, resource.file));
      if (!path.startsWith(root + sep)) throw new Error('Invalid resource path');
      let body = await readFile(path);
      const type = resource.type || 'application/octet-stream';
      if (/text\/|javascript|json|xml|svg/i.test(type)) body = Buffer.from(rewrite(body, source, entry, type));
      res.writeHead(resource.status, { 'Content-Type': type, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500); res.end('Archive resource unavailable');
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}${entry.pathname}${entry.search}` };
}
