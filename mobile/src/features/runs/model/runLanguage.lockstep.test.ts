/**
 * runLanguage.ts held to the web's runLanguage.js — a differential test: the
 * web module runs here beside the port on the same runs, and every sentence,
 * tone and placeholder must agree. The web keys are mapped through
 * HAPPENED_KEYS (the phone phrases the same English under `mobile.runs.*`),
 * so a web sentence that gains a key without a phone twin fails here too.
 *
 * The web module imports its status table from a file that pulls in the web's
 * icon package; that one import is stubbed with the phone's own status table,
 * which statusLockstep.test.ts already holds to the web's.
 *
 * When this fails, the web side changed: update runLanguage.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { statusToken } from '@/features/automations';
import { loadWebModule } from '@/shared/testing/webModule';

import {
    HAPPENED_KEYS,
    enteredTriggerLabel,
    errorClassLabel,
    outcomeLabel,
    triggerLabel,
    whatHappened,
    type RunLike,
} from './runLanguage';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Executions/runLanguage.js');

const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

interface WebWords { key: string; en: string; params?: Record<string, unknown>; tone?: string }
interface WebModule {
    whatHappened: (run: unknown) => WebWords;
    triggerLabel: (kind: unknown) => string;
    errorClassLabel: (cls: unknown) => string | null;
    outcomeLabel: (run: unknown) => WebWords;
    enteredTriggerLabel: (run: unknown, def?: unknown) => string | null;
}

function loadWeb(): WebModule {
    return loadWebModule<WebModule>(WEB, {
        tokenFor: (status: string) => {
            const token = statusToken(status);
            return { labelKey: token.labelKey, labelEn: token.labelEn };
        },
    });
}

const RUNS: RunLike[] = [
    {},
    { status: 'success' },
    { status: 'success', summary: '  Twelve   invoices\nfiled ' },
    { status: 'success', summary: 'x'.repeat(240) },
    { status: 'success', handledErrorCount: 1 },
    { status: 'success', handledErrorCount: 4 },
    { status: 'error', error: 'The Gmail connection expired.' },
    { status: 'failed', error: 'y'.repeat(400) },
    { status: 'error', errorClass: 'timeout' },
    { status: 'error', errorClass: 'Nobody-Knows' },
    { status: 'error', errorClass: 'ApprovalRejected', error: 'Approval rejected: not this month' },
    { status: 'error', errorClass: 'ApprovalRejected', error: 'Approval rejected' },
    { status: 'running' },
    { status: 'queued' },
    { status: 'awaiting_approval' },
    { status: 'awaiting_confirm' },
    { status: 'awaiting_form' },
    { status: 'cancelled' },
    { status: 'paused' },
    { status: 'SUCCESS' },
];

const TRIGGERS = [null, '', 'schedule', 'cron', 'MANUAL', 'manual_step', 'dry_run', 'form', 'form_page', 'app_event', 'chat', 'agent', 'webhook', 'studio_app', 'some_new_kind'];
const CLASSES = [null, '', 'auth', 'Connection', 'network', 'timeout', 'rate_limit', 'validation', 'permission', 'cancelled', 'HttpError'];

describe('where the port is deliberately stricter', () => {
    it('never answers a question about Object.prototype', () => {
        // The web's plain lookup returns the Object constructor for
        // "constructor"; the port reads only the table's own keys, like
        // features/automations/model/status.ts does.
        expect(triggerLabel('constructor')).toBe('constructor');
        expect(errorClassLabel('toString')).toBeNull();
    });
});

describeIfWeb('runLanguage matches the web', () => {
    let web: WebModule;
    beforeAll(() => {
        web = loadWeb();
    });

    it('says the same about every run, in the same tone', () => {
        for (const run of RUNS) {
            const mine = whatHappened(run);
            const theirs = web.whatHappened(run);
            expect({ run, en: mine.en, tone: mine.tone, params: mine.params }).toEqual({
                run,
                en: theirs.en,
                tone: theirs.tone,
                params: theirs.params,
            });
            expect({ run, key: mine.key }).toEqual({ run, key: HAPPENED_KEYS[theirs.key] ?? theirs.key });
        }
    });

    it('maps every web sentence key to a phone key', () => {
        const webKeys = RUNS.map((r) => web.whatHappened(r).key).filter((k) => k.startsWith('routines.runs.'));
        expect(webKeys.filter((k) => !HAPPENED_KEYS[k])).toEqual([]);
        expect(Object.values(HAPPENED_KEYS).every((k) => /^mobile\.runs\.happened\.[a-z_]+$/.test(k))).toBe(true);
    });

    it('names triggers and error classes the same way', () => {
        for (const kind of TRIGGERS) expect({ kind, label: triggerLabel(kind) }).toEqual({ kind, label: web.triggerLabel(kind) });
        for (const cls of CLASSES) expect({ cls, label: errorClassLabel(cls) }).toEqual({ cls, label: web.errorClassLabel(cls) });
    });

    it('reads the outcome word and the entered trigger the same way', () => {
        for (const run of RUNS) {
            const theirs = web.outcomeLabel(run);
            expect(outcomeLabel(run)).toEqual({ key: theirs.key, en: theirs.en });
        }
        for (const run of [{}, { rootStepId: 't2' }, { rootStepId: 't2', rootTriggerLabel: 'Inbox' }]) {
            expect(enteredTriggerLabel(run)).toBe(web.enteredTriggerLabel(run, null));
        }
    });
});
