import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CircleCheck, CircleDashed, CircleMinus, CircleX, TriangleAlert } from 'lucide-react';
import {
    TONES, TONE_KEYS, toneOfCheckStatus, toneOfScore, toneOfClock, toneOfSeverity,
    glyphOfCheckStatus, headlineKeyOfScore, HEADLINE_FALLBACK,
} from './statusTone';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('statusTone — one tone pair per status word', () => {
    it('every tone is a raw/ink PAIR of declared tokens and nothing else', () => {
        expect(TONE_KEYS).toEqual(['success', 'warning', 'error', 'neutral']);
        for (const k of TONE_KEYS) {
            expect(TONES[k].raw).toMatch(/^var\(--[a-z-]+\)$/);
            expect(TONES[k].ink).toMatch(/^var\(--[a-z-]+\)$/);
        }
        // The status pairs use the raw token + its -ink twin; neutral is the
        // "nothing to say" pair and must never borrow a status colour.
        expect(TONES.success).toEqual({ raw: 'var(--success)', ink: 'var(--success-ink)' });
        expect(TONES.warning).toEqual({ raw: 'var(--warning)', ink: 'var(--warning-ink)' });
        expect(TONES.error).toEqual({ raw: 'var(--error)', ink: 'var(--error-ink)' });
        expect(TONES.neutral).toEqual({ raw: 'var(--bg-tertiary)', ink: 'var(--text-tertiary)' });
        expect(Object.isFrozen(TONES)).toBe(true);
    });

    it('every token it names is declared in src/index.css (no --status-*, no hex)', () => {
        const css = fs.readFileSync(path.join(here, '..', '..', 'index.css'), 'utf8');
        const src = fs.readFileSync(path.join(here, 'statusTone.js'), 'utf8');
        for (const m of src.matchAll(/var\((--[a-z-]+)\)/g)) {
            expect(css.includes(`${m[1]}:`), `${m[1]} declared in index.css`).toBe(true);
        }
        expect(src).not.toMatch(/--status-/);
        expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });

    it('check status → tone', () => {
        expect(toneOfCheckStatus('pass')).toBe('success');
        expect(toneOfCheckStatus('warn')).toBe('warning');
        expect(toneOfCheckStatus('fail')).toBe('error');
        expect(toneOfCheckStatus('not_applicable')).toBe('neutral');
        expect(toneOfCheckStatus('pending')).toBe('neutral');
        expect(toneOfCheckStatus(undefined)).toBe('neutral');
    });

    it('score → tone at the ScoreRing thresholds; a missing score is neutral, never red', () => {
        expect(toneOfScore(100)).toBe('success');
        expect(toneOfScore(85)).toBe('success');
        expect(toneOfScore(84)).toBe('warning');
        expect(toneOfScore(60)).toBe('warning');
        expect(toneOfScore(59)).toBe('error');
        expect(toneOfScore(0)).toBe('error');
        expect(toneOfScore('79')).toBe('warning');
        expect(toneOfScore(null)).toBe('neutral');
        expect(toneOfScore(undefined)).toBe('neutral');
        expect(toneOfScore('—')).toBe('neutral');
    });

    it('clock state → tone', () => {
        expect(toneOfClock('ok')).toBe('success');
        expect(toneOfClock('urgent')).toBe('warning');
        expect(toneOfClock('overdue')).toBe('error');
        expect(toneOfClock('done')).toBe('neutral');
        expect(toneOfClock('none')).toBe('neutral');
        expect(toneOfClock(undefined)).toBe('neutral');
    });

    it('severity → ink tone (critical and high share the error ink; low is quiet)', () => {
        expect(toneOfSeverity('critical')).toBe('error');
        expect(toneOfSeverity('high')).toBe('error');
        expect(toneOfSeverity('medium')).toBe('warning');
        expect(toneOfSeverity('low')).toBe('neutral');
        expect(toneOfSeverity(undefined)).toBe('neutral');
    });

    it('status → glyph', () => {
        expect(glyphOfCheckStatus('pass')).toBe(CircleCheck);
        expect(glyphOfCheckStatus('warn')).toBe(TriangleAlert);
        expect(glyphOfCheckStatus('fail')).toBe(CircleX);
        expect(glyphOfCheckStatus('not_applicable')).toBe(CircleMinus);
        expect(glyphOfCheckStatus('pending')).toBe(CircleDashed);
        expect(glyphOfCheckStatus(undefined)).toBe(CircleDashed);
    });

    it('score → headline key, and every key has an English fallback', () => {
        expect(headlineKeyOfScore(90)).toBe('compliance.ovw_headline_good');
        expect(headlineKeyOfScore(70)).toBe('compliance.ovw_headline_attention');
        expect(headlineKeyOfScore(30)).toBe('compliance.ovw_headline_gaps');
        expect(headlineKeyOfScore(null)).toBe('compliance.ovw_headline_pending');
        for (const n of [90, 70, 30, null]) {
            expect(typeof HEADLINE_FALLBACK[headlineKeyOfScore(n)]).toBe('string');
        }
    });
});
