import { describe, expect, it } from 'vitest';
import { errorInfoTitle, runLogSentence, sentenceTooltip } from './runLogSentence';
import type { RunLogRow } from './runLogSentence';
import { interpolate } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';

// English t(): the fallback, with its {params} filled in.
const t: TranslateFn = (_key, fallbackOrParams, params) => (
    typeof fallbackOrParams === 'string' ? interpolate(fallbackOrParams, params) : ''
);

const RAW = '550 5.1.1 <finance-team@example.com>: Recipient address rejected: User unknown in virtual mailbox table';

const run = (over: Partial<RunLogRow> = {}): RunLogRow => ({ id: 'r1', status: 'success', ...over });

describe('runLogSentence', () => {
    it('says a failure in the classifier\'s plain words and keeps the raw message aside', () => {
        const s = runLogSentence(t, run({
            status: 'error',
            error: RAW,
            outcome: { code: 'stopped_at', params: { step: 'Post to finance', reasonCode: 'validation', reason: 'a setting has a value this step cannot use' } },
        }));
        expect(s.text).toBe('Stopped at "Post to finance": a setting has a value this step cannot use');
        expect(s.text).not.toContain('550');
        expect(s.tone).toBe('error');
        expect(s.technical).toBe(RAW);
    });

    it('never falls back to the raw message when the outcome carries no reason', () => {
        // The organisation log drops reasons that are not generic; the
        // builder's sentence would then print run.error verbatim.
        const s = runLogSentence(t, run({
            status: 'error',
            error: RAW,
            outcome: { code: 'stopped_at', params: { step: 'Post to finance', reasonCode: 'validation' } },
        }));
        expect(s.text).toBe('Stopped at "Post to finance"');
        expect(s.technical).toBe(RAW);
    });

    it('uses the builder\'s sentence for every other outcome code', () => {
        const waiting = runLogSentence(t, run({
            status: 'awaiting_approval',
            outcome: { code: 'waiting_approval', params: { who: 'S. de Boer' } },
        }));
        expect(waiting).toEqual({ text: 'Waiting for approval from S. de Boer', tone: 'warn', technical: null });
        const found = runLogSentence(t, run({
            outcome: { code: 'success', params: { kind: 'file', step: 'Classify the document', name: 'Contract.pdf' } },
        }));
        expect(found.text).toBe('Classify the document: Contract.pdf');
        expect(found.tone).toBe('neutral');
    });

    it('phrases an older failure from the step\'s errorInfo, then from the error class', () => {
        const info = { title: 'The Gmail sign-in has expired', titleKey: 'routines.step_error.auth_expired.title' };
        expect(runLogSentence(t, run({ status: 'error', error: 'Gmail API 401: invalid_grant' }), info).text)
            .toBe('Stopped: The Gmail sign-in has expired');
        expect(runLogSentence(t, run({ status: 'error', error: 'HTTP 401', errorClass: 'auth' })).text)
            .toBe('Stopped: the sign-in has expired');
        const bare = runLogSentence(t, run({ status: 'error', error: 'ECONNRESET 10.0.0.4:443' }));
        expect(bare.text).toBe('Stopped before it finished');
        expect(bare.technical).toBe('ECONNRESET 10.0.0.4:443');
    });

    it('reads a rejection as a decision, not a fault', () => {
        const s = runLogSentence(t, run({ status: 'error', errorClass: 'ApprovalRejected', error: 'Approval rejected: over budget' }));
        expect(s.tone).toBe('warn');
        expect(s.technical).toBeNull();
        expect(s.text).toContain('over budget');
    });
});

describe('errorInfoTitle and sentenceTooltip', () => {
    it('translates the title by its key, falling back to the English', () => {
        const keyed: TranslateFn = (key, fallback) => (key === 'x.title' ? 'Vertaald' : String(fallback));
        expect(errorInfoTitle(keyed, { title: 'Plain', titleKey: 'x.title' })).toBe('Vertaald');
        expect(errorInfoTitle(t, { title: '  Plain  ' })).toBe('Plain');
        expect(errorInfoTitle(t, null)).toBeNull();
    });

    it('puts the raw message in the hover only', () => {
        expect(sentenceTooltip(t, { text: 'Stopped', tone: 'error', technical: RAW })).toBe(`Stopped\nTechnical message: ${RAW}`);
        expect(sentenceTooltip(t, { text: 'Finished', tone: 'neutral', technical: null })).toBe('Finished');
    });
});
