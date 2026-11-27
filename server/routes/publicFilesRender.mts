/**
 * File-shaped addresses of the public site that no page or route claimed.
 * Mounted at the end of routes/publicRender.js, so robots.txt, sitemap.xml,
 * the feeds, llms.txt and every page have had their turn.
 *
 *   - `/<INDEXNOW_KEY>.txt`: the IndexNow key file (usecases/cmsIndexNow.mts).
 *   - `/index.html`, `/nl/index.html`, `/blog/index.html`: one 301 to the
 *     address of that page, query kept. The shell answered them with a 200, a
 *     second address for the homepage.
 *   - any other `.xml` or `.txt`: 404. It fell through to the SPA shell, a 200
 *     of HTML claiming to be a sitemap or a text file (crawlers probe
 *     sitemap_index.xml, ads.txt and the like). `X-Beeflow-Render: not-found`
 *     keeps nginx from turning the 404 back into the shell (agent-hub/nginx.conf.template).
 *
 * Paths are compared with plain string operations: no regular expression runs
 * over the request.
 */

import { createRequire } from 'node:module';
import type { Request, Response, NextFunction, Router } from 'express';
import { indexNowKey } from '../usecases/cmsIndexNow.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { parsePublicPath, buildPublicPath } = nodeRequire('../core/seo/publicPath') as typeof import('../core/seo/publicPath.js');
const log = nodeRequire('../telemetry/log') as { warn: (...a: unknown[]) => void };

const INDEX_HTML = '/index.html';

interface Deps { siteLocales: () => Promise<{ defaultLocale: string, locales: string[] }> }

/** The query string as sent, without '?'. */
function queryOf(req: Request): string {
    const url = String(req.originalUrl || req.url || '');
    const at = url.indexOf('?');
    return at === -1 ? '' : url.slice(at + 1);
}

/** The page address for `<page>/index.html`, or null when what is left is not a page address. */
export function indexHtmlTarget(path: string, locales: string[], defaultLocale: string): string | null {
    if (!path.toLowerCase().endsWith(INDEX_HTML)) return null;
    const parsed = parsePublicPath(path.slice(0, -INDEX_HTML.length) || '/', locales);
    return parsed ? buildPublicPath(parsed.locale, parsed.slug, defaultLocale) : null;
}

export function createPublicFilesRouter({ siteLocales }: Deps): Router {
    const router = express.Router();
    // A middleware, not a route: it claims no address of its own (the route contract lists routes).
    router.use(async (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        try {
            const key = indexNowKey();
            if (key && req.path === `/${key}.txt`) {
                res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
                return res.send(key);
            }
            if (req.path.toLowerCase().endsWith(INDEX_HTML)) {
                const { defaultLocale, locales } = await siteLocales();
                const target = indexHtmlTarget(req.path, locales, defaultLocale);
                const qs = queryOf(req);
                // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- the target is buildPublicPath(...) of a parsed marketing path: one leading "/", [a-z0-9-] segments
                if (target) return res.redirect(301, qs ? `${target}?${qs}` : target);
            }
            const lower = req.path.toLowerCase();
            if (lower.endsWith('.xml') || lower.endsWith('.txt')) {
                return res.status(404).type('text/plain').set('Cache-Control', 'public, max-age=300')
                    .set('X-Beeflow-Render', 'not-found').send('Not found');
            }
            return next();
        } catch (err) {
            log.warn('[SEO] file route failed for', req.path, '-', (err as Error).message);
            return next();
        }
    });
    return router;
}
