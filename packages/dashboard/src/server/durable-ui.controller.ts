import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Header, NotFoundException, Param, StreamableFile } from '@nestjs/common';

/** dist/server/durable-ui.controller.js -> ../spa (the Vite build output). */
function spaDir(): string {
  return fileURLToPath(new URL('../spa', import.meta.url));
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Serves the bundled control-plane SPA at `/durable` (+ hashed assets at `/durable/assets`). */
@Controller('durable')
export class DurableUiController {
  private readonly dir = spaDir();

  // index.html references hash-named bundles, so it MUST NOT be cached (stale bundle = the
  // classic "stuck loading after a deploy"). The hashed assets below are immutable.
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, must-revalidate')
  index(): string {
    const indexPath = join(this.dir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new NotFoundException('Dashboard is not built. Run the package build.');
    }
    const html = readFileSync(indexPath, 'utf8');
    const inject = `<script>window.__DURABLE_BASE__='/durable';</script>`;
    return html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : inject + html;
  }

  @Get('assets/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  asset(@Param('file') file: string): StreamableFile {
    const safe = basename(file);
    if (safe !== file) throw new NotFoundException();
    const root = resolve(this.dir, 'assets');
    const assetPath = resolve(root, safe);
    if (!assetPath.startsWith(root + sep) || !existsSync(assetPath)) {
      throw new NotFoundException();
    }
    const type = CONTENT_TYPES[extname(safe)] ?? 'application/octet-stream';
    return new StreamableFile(readFileSync(assetPath), { type });
  }
}
