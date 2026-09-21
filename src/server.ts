import { createServer, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';
import { createBridge } from './bridge.js';
import type { BridgeConfig, BridgeOptions } from './types.js';
export { loadConfig } from './config.js';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const MAX_BODY = 16 * 1024 * 1024;
const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
function sendJson(response: ServerResponse, status: number, detail: string) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ detail }));
}
export function createNodeServer(config: BridgeConfig, options: BridgeOptions & { demosDirectory?: string } = {}) {
  const handler = createBridge(config, options);
  const demosRoot = options.demosDirectory ? resolve(options.demosDirectory) : undefined;
  return createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url || '/', `http://${incoming.headers.host || 'localhost'}`);
      if (demosRoot && (incoming.method === 'GET' || incoming.method === 'HEAD')) {
        if (url.pathname === '/' || url.pathname === '/demos') {
          outgoing.writeHead(302, { Location: '/demos/' }); outgoing.end(); return;
        }
        if (url.pathname.startsWith('/demos/')) {
          let filename = resolve(demosRoot, '.' + decodeURIComponent(url.pathname.slice('/demos'.length)));
          const rel = relative(demosRoot, filename);
          if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) { sendJson(outgoing, 404, 'Not Found'); return; }
          try {
            const info = await stat(filename);
            if (info.isDirectory()) {
              if (!url.pathname.endsWith('/')) { outgoing.writeHead(302, { Location: url.pathname + '/' + url.search }); outgoing.end(); return; }
              filename = resolve(filename, 'index.html');
            }
            const canonicalRoot = await realpath(demosRoot), canonical = await realpath(filename);
            const actualRelative = relative(canonicalRoot, canonical);
            if (actualRelative.startsWith('..' + sep) || actualRelative === '..' || isAbsolute(actualRelative)) { sendJson(outgoing, 404, 'Not Found'); return; }
            const mime = MIME[extname(filename)];
            if (!mime) { sendJson(outgoing, 404, 'Not Found'); return; }
            let content: Buffer | string = await readFile(filename);
            if (extname(filename) === '.html') content = content.toString('utf8').replace('<head>', `<head>\n<meta name="jev-endpoint" content="${escapeAttribute(url.origin)}">`);
            outgoing.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
            outgoing.end(incoming.method === 'HEAD' ? undefined : content); return;
          } catch { sendJson(outgoing, 404, 'Demo files not found; run git submodule update --init'); return; }
        }
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY) { sendJson(outgoing, 413, 'request body exceeds 16 MiB'); return; }
        chunks.push(buffer);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const response = await handler(new Request(url, {
        method: incoming.method || 'GET', headers,
        ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.headersSent) sendJson(outgoing, 400, 'invalid request'); else outgoing.end(); }
  });
}
