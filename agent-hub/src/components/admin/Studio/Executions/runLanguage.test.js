import { describe, it, expect } from 'vitest';
import EN_DEFAULTS from '../../../../i18n/en-defaults';
import { outcomeLabel, whatHappened, triggerLabel, runTitle, errorClassLabel, runIdFromText, enteredTriggerLabel } from './runLanguage';

/**
 * The runs UI speaks in sentences, not machine words — and every status the
 * server can emit must map to SOMETHING readable, because an unmapped status
 * silently regresses to jargon.
 *
 * Both functions hand back `{ key, en }` rather than a finished string: the
 * caller renders `t(key, en)`. `outcomeLabel` used to return the English word
 * alone, which is how the Dutch UI ended up printing a translated sentence
 * with an English status word interpolated into it.
 */
const STATUSES = ['success', 'error', 'failed', 'running', 'queued', 'paused', 'cancelled', 'awaiting_approval', 'awaiting_confirm', 'awaiting_form', 'skipped', 'handled_error', 'weird_future_status'];

describe('outcomeLabel / whatHappened', () => {
    it('every server status reads as a plain word', () => {
        for (const status of STATUSES) {
            const { en } = outcomeLabel({ status });
            expect(typeof en, status).toBe('string');
            expect(en.length, status).toBeGreaterThan(0);
            expect(en, status).not.toMatch(/_/); // no snake_case leaks
            const sentence = whatHappened({ status });
            expect(sentence.en.length, status).toBeGreaterThan(0);
        }
    });

    it('every status names a real dictionary key, so a Dutch UI gets a Dutch word', () => {
        for (const status of STATUSES) {
            const { key, en } = outcomeLabel({ status });
            expect(key, status).toMatch(/^run_status\.[a-z_]+$/);
            expect(EN_DEFAULTS[key], key).toBe(en);
        }
    });

    it('lets a status with no sentence of its own BE the sentence, key and all', () => {
        // The old last branch read `routines.runs.status_plain` ("{status}")
        // and interpolated the English word into it — a translated sentence
        // with an untranslated word inside. These statuses take that branch.
        for (const status of ['paused', 'skipped', 'handled_error', 'weird_future_status']) {
            const word = outcomeLabel({ status });
            const sentence = whatHappened({ status });
            expect(sentence.key, status).toBe(word.key);
            expect(sentence.en, status).toBe(word.en);
            expect(sentence.params, status).toEqual({});
        }
    });

    it('keeps its own sentences translatable too', () => {
        for (const run of [{ status: 'running' }, { status: 'awaiting_form' }, { status: 'cancelled' }, { status: 'success' }]) {
            const sentence = whatHappened(run);
            expect(EN_DEFAULTS[sentence.key], `${run.status} → ${sentence.key}`).toBeTypeOf('string');
        }
    });

    it('a failure leads with the reason, not the word "error"', () => {
        const s = whatHappened({ status: 'error', error: 'Mailbox not connected. Extra detail here.' });
        expect(s.tone).toBe('error');
        expect(s.en).toContain('Failed — Mailbox not connected');
    });

    it('falls back to the typed error class when there is no message', () => {
        const s = whatHappened({ status: 'error', errorClass: 'timeout' });
        expect(s.en).toContain('took too long');
    });

    it('a success with absorbed failures says so', () => {
        const s = whatHappened({ status: 'success', handledErrorCount: 2 });
        expect(s.key).toBe('routines.runs.finished_handled');
        expect(s.en).toBe('Finished — 2 problems handled automatically');
        expect(s.params).toEqual({ n: 2 });
        expect(s.tone).toBe('warn');
    });

    it('the singular fallback belongs to the singular KEY — no "s" welded on in JS', () => {
        // The key choice was already a pair; the `en` beside it still ran
        // `problem${n === 1 ? '' : 's'}`, so the English plural rule lived in
        // JavaScript one line under the ternary that had just removed it. The
        // two branches are two complete sentences now.
        const one = whatHappened({ status: 'success', handledErrorCount: 1 });
        expect(one.key).toBe('routines.runs.finished_handled_one');
        expect(one.en).toBe('Finished — 1 problem handled automatically');
        expect(one.params).toEqual({ n: 1 });
        expect(one.tone).toBe('warn');
    });

    it('carries no grammar in code: no fallback builds a word out of a ternary', async () => {
        // A file-wide guard, not a claim about one sentence — this is where
        // the pattern kept coming back. TRIGGER_LABELS/ERROR_CLASS_LABELS in
        // this same file carry no key at all and are the RUN track's debt
        // (i18nGuard TEXT_HELPERS lists this file as pending for exactly
        // that); this check is about grammar, not about those tables.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.join(__dirname, 'runLanguage.js'), 'utf8');
        expect(src).not.toMatch(/\$\{[^}]*\?\s*''\s*:\s*'/);
        expect(src).not.toMatch(/\$\{[^}]*\?\s*"[^"]*"\s*:\s*"s"/);
    });
});

describe('triggerLabel', () => {
    it('maps every known trigger kind to a sentence', () => {
        expect(triggerLabel('schedule')).toBe('On a schedule');
        expect(triggerLabel('manual')).toBe('Started by hand');
        expect(triggerLabel('webhook')).toMatch(/another system/);
        expect(triggerLabel('dry_run')).toBe('Test run');
        expect(triggerLabel(null)).toBe('—');
        // Unknown kinds degrade to readable words, never snake_case.
        expect(triggerLabel('some_new_kind')).toBe('some new kind');
    });
});

describe('errorClassLabel', () => {
    it('names the classes it knows and stays null for the rest', () => {
        expect(errorClassLabel('auth')).toMatch(/signed in/);
        expect(errorClassLabel('unknown_class')).toBeNull();
        expect(errorClassLabel(null)).toBeNull();
    });
});

describe('runTitle', () => {
    it('names a run by WHEN it ran, flagging tests', () => {
        const t = runTitle({ startedAt: '2026-08-12T14:03:00Z', mode: 'live' }, 'en-GB');
        expect(t).toMatch(/^Run of /);
        expect(t).not.toContain('test');
        expect(runTitle({ startedAt: '2026-08-12T14:03:00Z', mode: 'dry_run' }, 'en-GB')).toMatch(/· test$/);
    });

    it('degrades to the short id only when there is no timestamp', () => {
        expect(runTitle({ id: 'run_abcdef123456' })).toBe('Run run_abcd');
    });
});

describe('runIdFromText', () => {
    it('pulls the id out of a pasted deep link', () => {
        expect(runIdFromText('https://x.example/app/studio/routines/a1?view=runs&run=run_12345abc&step=s1')).toBe('run_12345abc');
    });
    it('accepts a bare id', () => {
        expect(runIdFromText('run_12345abc')).toBe('run_12345abc');
        expect(runIdFromText('  b47ac10b-58cc  ')).toBe('b47ac10b-58cc');
    });
    it('rejects prose', () => {
        expect(runIdFromText('please open my last run')).toBeNull();
        expect(runIdFromText('')).toBeNull();
    });
});

/**
 * A routine with several triggers: which entry point a run came in through.
 * Primary-trigger runs (and legacy rows) carry no rootStepId and read as
 * nothing extra — the "Started by" column already says how it started.
 */
describe('enteredTriggerLabel', () => {
    const snapshot = { trigger: { id: 'trg', kind: 'app_event' }, triggers: [{ id: 'trig_b', kind: 'app_event', label: 'Label commands', appEvent: { provider: 'gmail', event: 'label.added' } }] };
    it('is null for a primary-trigger run', () => {
        expect(enteredTriggerLabel({ rootStepId: null, rootTriggerLabel: null })).toBeNull();
        expect(enteredTriggerLabel({})).toBeNull();
    });
    it('prefers the label from the definition snapshot that ran', () => {
        expect(enteredTriggerLabel({ rootStepId: 'trig_b', rootTriggerLabel: 'Renamed since' }, snapshot)).toBe('Label commands');
    });
    it('falls back to the server-resolved label for a list row without a snapshot', () => {
        expect(enteredTriggerLabel({ rootStepId: 'trig_b', rootTriggerLabel: 'Label commands' })).toBe('Label commands');
    });
    it('reads the event when the node has no label, and nothing when it is gone from the snapshot', () => {
        const bare = { triggers: [{ id: 'trig_b', kind: 'app_event', appEvent: { provider: 'gmail', event: 'label.added' } }] };
        expect(enteredTriggerLabel({ rootStepId: 'trig_b' }, bare)).toBe('label.added');
        expect(enteredTriggerLabel({ rootStepId: 'trig_gone', rootTriggerLabel: null }, snapshot)).toBeNull();
    });
});
