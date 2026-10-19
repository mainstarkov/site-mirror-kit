#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { capture, serve } from './index.js';

const help = `site-mirror capture <URL> [--out captures/site] [--pages 1] [--wait 1500] [--channel chrome] [--serve] [--port 4173]
site-mirror serve <directory> [--port 4173]

Captures browser-visible GET responses, not server source code.
Only GET/HEAD are allowed; forms and live backend operations are disabled.
Install Chromium first: npx playwright install chromium`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: 'string', default: 'captures/site' }, pages: { type: 'string', default: '1' },
    wait: { type: 'string', default: '1500' }, channel: { type: 'string' },
    serve: { type: 'boolean' }, port: { type: 'string', default: '4173' }, help: { type: 'boolean', short: 'h' }
  } });
  const [command, target] = positionals;
  if (values.help || !command) { console.log(help); }
  else {
    if (!target || positionals.length !== 2 || !['capture', 'serve'].includes(command)) throw new Error(help);
    let directory = resolve(target);
    if (command === 'capture') {
      const result = await capture(target, values.out, { maxPages: Number(values.pages), waitMs: Number(values.wait), channel: values.channel, onProgress: console.log });
      directory = result.directory;
      console.log(`Saved: ${directory}\nPages: ${result.manifest.pages.length}; resources: ${Object.keys(result.manifest.resources).length}; issues: ${result.manifest.errors.length}`);
      console.log(`Replay: site-mirror serve "${directory}"`);
    }
    if (command === 'serve' || values.serve) {
      const { server, url } = await serve(directory, { port: Number(values.port) });
      console.log(`Local copy: ${url}\nStop: Ctrl+C`);
      process.once('SIGINT', () => server.close());
      process.once('SIGTERM', () => server.close());
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
