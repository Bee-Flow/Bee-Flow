/**
 * One source's documents: the chip → query mapping, the counts, "pending"
 * and the status words — each held to the web's SourceDetail.jsx, textually,
 * so a change there fails here.
 */

import fs from 'node:fs';
import path from 'node:path';

import { docStatusOf, hasUnscanned, isPendingDoc, nextDocOffset, SOURCE_DOC_PAGE, sourceDocCounts, sourceDocParams } from './sourceDocuments';
import type { KbSource } from './types';

const REPO = path.resolve(__dirname, '../../../../..');
const WEB = fs.readFileSync(path.join(REPO, 'agent-hub/src/components/admin/Studio/KnowledgeStudio/SourceDetail.jsx'), 'utf8');

describe('sourceDocParams', () => {
    it('maps each chip onto the route’s filters and trims the search', () => {
        expect(sourceDocParams('all', '')).toEqual({});
        expect(sourceDocParams('processed', '  terms ')).toEqual({ status: 'processed,redacted', q: 'terms' });
        expect(sourceDocParams('skipped', '')).toEqual({ status: 'skipped,error' });
        expect(sourceDocParams('pii', '')).toEqual({ pii: 'found' });
    });

    it('is the web’s mapping and page size', () => {
        expect(WEB).toContain("if (filter === 'processed') p.status = 'processed,redacted';");
        expect(WEB).toContain("if (filter === 'skipped') p.status = 'skipped,error';");
        expect(WEB).toContain("if (filter === 'pii') p.pii = 'found';");
        expect(WEB).toContain(`const PAGE_SIZE = ${SOURCE_DOC_PAGE};`);
    });
});

describe('sourceDocCounts', () => {
    it('adds shielded to processed and failed to skipped, like the web’s chips', () => {
        const source = { documentCount: 10, processedCount: 5, redactedCount: 2, skippedCount: 1, errorCount: 2, piiFoundCount: 3 } as KbSource;
        expect(sourceDocCounts(source)).toEqual({ all: 10, processed: 7, skipped: 3, pii: 3 });
        expect(WEB).toContain("n('processedCount') + n('redactedCount')");
        expect(WEB).toContain("n('skippedCount') + n('errorCount')");
    });
});

describe('status', () => {
    it('reads a queued upload as pending by its reason, not its status', () => {
        expect(isPendingDoc({ status: 'skipped', status_reason: 'Queued for processing' })).toBe(true);
        expect(isPendingDoc({ status: 'skipped', status_reason: 'Empty file' })).toBe(false);
        expect(docStatusOf({ status: 'skipped', status_reason: 'Queued for processing' })?.key).toBe('knowledge.docs.status_processing');
    });

    it('uses the web’s key and English for every status', () => {
        for (const status of ['processed', 'redacted', 'skipped', 'error', 'duplicate'] as const) {
            const s = docStatusOf({ status });
            expect(s).not.toBeNull();
            expect(WEB).toContain(`key: '${s?.key}', fallback: '${s?.en}'`);
        }
    });

    it('says nothing when an older server did not send a status', () => {
        expect(docStatusOf({})).toBeNull();
    });

    it('flags unscanned rows unless they were skipped', () => {
        expect(hasUnscanned([{ status: 'processed', pii_status: 'unscanned' }])).toBe(true);
        expect(hasUnscanned([{ status: 'skipped', pii_status: 'unscanned' }, { status: 'processed', pii_status: 'none' }])).toBe(false);
    });
});

describe('nextDocOffset', () => {
    const docs = (n: number) => Array.from({ length: n }, () => ({}) as never);
    it('pages on until the total is reached', () => {
        expect(nextDocOffset({ documents: docs(50), offset: 0, total: 120 })).toBe(50);
        expect(nextDocOffset({ documents: docs(20), offset: 100, total: 120 })).toBeUndefined();
        expect(nextDocOffset({ documents: [], offset: 50, total: 120 })).toBeUndefined();
    });
});
