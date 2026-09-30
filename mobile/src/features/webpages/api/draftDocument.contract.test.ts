/**
 * The draft document the preview shows, pinned against the server's own
 * handler (server/routes/webpages/draftDocument.js), read as text like
 * core/api/serverContract.test.ts does.
 *
 * What the phone relies on: the route's path and method, that the router
 * registers it, every key readDraftDocument reads, and every status it
 * knows. A rename on the server has to fail here, not render an empty frame.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/webpages/api/draftDocument.contract.test.ts
 */

import fs from 'node:fs';
import path from 'node:path';

import { api } from '@/core/api/client';

import { readDraftDocument } from './buildReaders';
import { getDraftDocument } from './endpoints';

jest.mock('@/core/api/client', () => ({ api: { get: jest.fn() } }));

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const handler = read('routes/webpages/draftDocument.js');

describe('GET /api/webpages/:id/draft-document', () => {
    it('is the route the phone calls, registered on the webpages router', async () => {
        expect(handler).toContain("router.get('/:id/draft-document'");
        expect(read('routes/webpages/index.js')).toContain("require('./draftDocument').register(router, deps);");
        (api.get as jest.Mock).mockResolvedValue({});
        await getDraftDocument('wp1');
        expect(api.get).toHaveBeenCalledWith('/api/webpages/wp1/draft-document', { signal: undefined });
    });

    it('answers every key the reader reads', () => {
        const body = handler.slice(handler.indexOf('res.json({'));
        for (const key of ['status', 'html', 'buildError', 'expiresAt']) {
            expect(body).toMatch(new RegExp(`\\b${key}[:,]`));
        }
    });

    it('can answer every status the reader knows, and no other', () => {
        const list = /const DRAFT_STATUSES = Object\.freeze\(\[([^\]]*)\]\)/.exec(handler)?.[1] ?? '';
        const statuses = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
        expect(statuses).toEqual(['ready', 'empty', 'stranded', 'build_error']);
        for (const status of statuses) {
            expect(readDraftDocument({ status, html: '<p></p>' }).status).toBe(status);
        }
    });
});
