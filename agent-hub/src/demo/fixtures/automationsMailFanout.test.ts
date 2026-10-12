// @vitest-environment node
/**
 * The "Fabrikam invoice mails" demo fan-out has the shape the output tables
 * are drawn against: 4 mails with 16 attachments each, 64 attachment reads of
 * which 60 failed, invoices three list levels deep, every per-item step's
 * list resolving from the recorded run the way the runner walks it, and no
 * address outside the reserved example domains.
 *
 * Run: cd agent-hub && npx vitest run src/demo/fixtures/automationsMailFanout.test.ts
 */
import { describe, it, expect } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { createDemoTransport } from '../demoTransport';
import { COMMON_ROUTES } from './common';
import * as automations from './automations';
import {
    MAIL_FANOUT_AUTOMATION_ID,
    MAIL_FANOUT_CATALOG_APP,
    MAIL_FANOUT_STEP_RESULTS,
    mailFanoutAutomationFields,
    seedMailFanoutRuns,
} from './automationsMailFanout';

type Json = Record<string, any>;

const out = (stepId: string) => MAIL_FANOUT_STEP_RESULTS[stepId].output as Json;
const RUN_STATE = { steps: Object.fromEntries(Object.keys(MAIL_FANOUT_STEP_RESULTS).map(id => [id, { output: out(id) }])) };
const steps = () => (mailFanoutAutomationFields().definition as Json).steps as Json[];

describe('mail fan-out demo: the recorded run', () => {
    it('reads 4 mails, each with 16 attachments carrying the 7 gmail_read keys', () => {
        const read = out('mf_read');
        expect([read.iterations, read.succeeded, read.failed]).toEqual([4, 4, 0]);
        for (const row of read.results) {
            expect(row.output.attachments).toHaveLength(16);
            for (const a of row.output.attachments) {
                expect(Object.keys(a)).toEqual(['filename', 'mimeType', 'size', 'attachmentId', 'canOCR', 'messageId', 'threadId']);
                expect(a.canOCR).toBe(a.mimeType === 'application/pdf');
            }
        }
    });

    it('gives every mail the same subject and the search summary keys in JSONB order', () => {
        const items = out('mf_read').results.map((r: Json) => r.item);
        expect(new Set(items.map((i: Json) => i.subject)).size).toBe(1);
        expect(Object.keys(items[0])).toEqual(['id', 'to', 'date', 'from', 'isBulk', 'snippet', 'subject', 'precedence', 'hasListUnsubscribe']);
    });

    it('records 64 attachment reads: 4 PDFs with text, 60 images that failed', () => {
        const att = out('mf_read_attachment');
        expect([att.iterations, att.succeeded, att.failed]).toEqual([64, 4, 60]);
        const failed = att.results.filter((r: Json) => r.status === 'error');
        expect(failed).toHaveLength(60);
        expect(failed.every((r: Json) => r.output === null && r.errorClass === 'IntegrationError' && /^gmail_read_attachment failed: /.test(r.error))).toBe(true);
        const ok = att.results.filter((r: Json) => r.status === 'success');
        expect(ok.map((r: Json) => r.output.extractedVia)).toEqual(['pdfjs', 'pdfjs', 'pdfjs', 'pdfjs']);
    });

    it('extracts invoices three list levels deep', () => {
        const [first] = out('mf_extract').results;
        expect(out('mf_extract').iterations).toBe(4);
        expect(first.output.invoice.number).toBe('F-2026-0917');
        expect(first.output.lines[0].sku).toBe('DSK-180-OAK');
        expect(Object.keys(first.output.lines[0].taxes[0])).toEqual(['rate', 'amount']);
    });

    it('resolves every per-item list from the recorded run, as the runner walks it', () => {
        const sizes = steps().filter(s => s.forEach).map(s => [s.id, (getPath(RUN_STATE, s.forEach.overRef) as unknown[]).length]);
        expect(sizes).toEqual([['mf_read', 4], ['mf_read_attachment', 64], ['mf_extract', 4]]);
    });

    it('uses only addresses on the reserved example domains', () => {
        const all = JSON.stringify([MAIL_FANOUT_STEP_RESULTS, MAIL_FANOUT_CATALOG_APP, mailFanoutAutomationFields(), seedMailFanoutRuns()]);
        const domains = [...all.matchAll(/@([\w.-]+)/g)].map(m => m[1].toLowerCase());
        expect(domains.length).toBeGreaterThan(0);
        expect(domains.filter(d => !d.endsWith('.example') && d !== 'example.com')).toEqual([]);
    });
});

describe('mail fan-out demo: wired into the Automations demo', () => {
    const demo = () => {
        const state = automations.createState();
        const fetch = createDemoTransport({ ...COMMON_ROUTES, ...automations.ROUTES }, state) as (url: string, init?: Json) => Promise<Response>;
        return async (url: string) => (await fetch(url)).json() as Promise<Json>;
    };

    it('lists the automation and serves its run with every step output', async () => {
        const call = demo();
        const { runs } = await call(`/api/automation/${MAIL_FANOUT_AUTOMATION_ID}/runs`);
        expect(runs.map((r: Json) => r.id)).toEqual(['run_demo_mf_01']);
        const { steps: rows } = await call('/api/automation/runs/run_demo_mf_01/steps');
        expect(rows.map((r: Json) => r.stepId)).toEqual(['trg', 'mf_search', 'mf_read', 'mf_read_attachment', 'mf_extract']);
        expect(rows.find((r: Json) => r.stepId === 'mf_read_attachment').output.failed).toBe(60);
    });

    it('puts Gmail with its three read actions in the catalog', async () => {
        const { apps } = await demo()('/api/automation/catalog');
        const gmail = apps.find((a: Json) => a.id === 'gmail');
        expect(gmail.actions.map((a: Json) => a.name)).toEqual(['gmail_search', 'gmail_read', 'gmail_read_attachment']);
    });
});
