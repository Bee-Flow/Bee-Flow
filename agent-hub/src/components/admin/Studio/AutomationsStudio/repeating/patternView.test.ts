import { describe, expect, it } from 'vitest';
import type { Pattern, RepeatingSuggestion } from '../../../../../api/queries/automation/repeating';
import { interpolate } from '../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import {
    appChain, cadenceBars, evidencePills, feedbackSuggestion, makeLabelFor, minutesText, parseRetrySeconds,
    patternEyebrow, reasonTexts, suggestionKey, templateParts, whenText,
} from './patternView';

// The English fallback, interpolated: what the page shows without a catalogue.
const t: TranslateFn = (_key, fb, params) => interpolate(typeof fb === 'string' ? fb : _key, typeof fb === 'string' ? params : fb);
const labelFor = makeLabelFor([
    { id: 'mail', kind: 'live', connected: true, apps: [{ id: 'gmail', label: 'Gmail', connected: true }] },
], t);

const pattern = (over: Partial<Pattern> = {}): Pattern => ({
    kind: 'mail_template', signature: 'sig-1',
    cadence: { kind: 'weekly', weekday: 1, hourBand: [9, 10], perMonth: 4.3, weeksPresent: 3, weeksWindow: 4 },
    occurrences: 14, windowDays: 90, distinctDays: 12,
    weekdayHistogram: [0, 9, 2, 0, 1, 0, 0],
    minutesPerMonth: [60, 120], basis: 'heuristic', template: 'Invoice <n> from <org>',
    apps: ['gmail', 'google_sheets'], draft: null, reasons: ['frequent', 'regular'], confidence: 'normal',
    ...over,
});
const suggestion = (over: Partial<RepeatingSuggestion> = {}): RepeatingSuggestion => ({
    id: 's1', title: 'Invoice to sheet', pattern: pattern(), ...over,
});

describe('names', () => {
    it('prefers the server label, then the app registry, then the id in words', () => {
        expect(labelFor('gmail')).toBe('Gmail');
        expect(labelFor('mail')).toBe('Mail');
        expect(labelFor('files')).toBe('Files');
        expect(labelFor('google_sheets')).toMatch(/Sheets/);
        expect(labelFor('acme_crm')).toBe('Acme Crm');
    });

    it('chains apps with an arrow', () => {
        expect(appChain(['gmail', 'acme_crm'], labelFor)).toBe('Gmail → Acme Crm');
    });
});

describe('cadence', () => {
    it('writes the kicker with the weekday and the hour band', () => {
        expect(patternEyebrow(pattern(), t)).toBe('Pattern · Weekly · Mon 09–10');
        expect(whenText(pattern({ cadence: { kind: 'daily' } }), t)).toBe('');
        expect(patternEyebrow(pattern({ cadence: { kind: 'irregular' } }), t)).toBe('Pattern · Irregular');
    });

    it('draws seven bars Monday first, scaled to the busiest day', () => {
        const bars = cadenceBars([0, 9, 2, 0, 1, 0, 3]);
        expect(bars.map(b => b.day)).toEqual([1, 2, 3, 4, 5, 6, 0]);
        expect(bars[0]).toEqual({ day: 1, count: 9, level: 6 });
        expect(bars[2].level).toBe(0);
        expect(bars[3].level).toBe(1); // a single event still shows
        expect(cadenceBars([0, 0, 0, 0, 0, 0, 0]).every(b => b.level === 0)).toBe(true);
    });
});

describe('evidence', () => {
    it('states time as a range, in minutes or hours, never as one number', () => {
        expect(minutesText([20, 40], t)).toBe('≈20–40 min/month');
        expect(minutesText([60, 120], t)).toBe('≈1–2 h/month');
        expect(minutesText([0, 0], t)).toBe('');
        expect(minutesText(null, t)).toBe('');
    });

    it('lists how often, how steady, how long, which apps, in that order', () => {
        const pills = evidencePills(suggestion({ pattern: pattern({ confidence: 'early' }) }), t, labelFor);
        expect(pills.map(p => p.id)).toEqual(['times', 'weeks', 'minutes', 'apps', 'early']);
        expect(pills[0].text).toBe('14× in 90 days');
        expect(pills[1].text).toBe('3 of 4 weeks');
        expect(pills[2].text).toBe('≈1–2 h/month (estimated)');
        expect(pills[3].text).toMatch(/^Gmail → .*Sheets$/);
        expect(pills[4].text).toBe('Early signal');
    });

    it('says measured when the time comes from real sessions', () => {
        const pills = evidencePills(suggestion({ pattern: pattern({ basis: 'measured', minutesPerMonth: [10, 20] }) }), t, labelFor);
        expect(pills.find(p => p.id === 'minutes')?.text).toBe('≈10–20 min/month (measured)');
    });

    it('moves an unconnected app out of the chain and into a warning', () => {
        const pills = evidencePills(suggestion({ unavailableIntegrations: ['google_sheets'] }), t, labelFor);
        expect(pills.find(p => p.id === 'apps')?.text).toBe('Gmail');
        expect(pills.find(p => p.id === 'needs')?.text).toMatch(/needs .*Sheets connected/);
    });

    it('shows only the apps for a suggestion without a pattern', () => {
        const pills = evidencePills({ id: 'x', title: 'Old', requiredIntegrations: ['gmail'] }, t, labelFor);
        expect(pills.map(p => p.text)).toEqual(['Gmail']);
    });
});

describe('reasons and template', () => {
    it('puts reason codes into words and drops unknown codes', () => {
        expect(reasonTexts(['frequent', 'bogus', 'recent'], t)).toEqual(['It happens often', 'It still happened in recent weeks']);
    });

    it('splits a masked template into text and worded placeholders', () => {
        expect(templateParts('Invoice <n> from <org> (<domain:A>)', t)).toEqual([
            { text: 'Invoice ', placeholder: false },
            { text: 'number', placeholder: true },
            { text: ' from ', placeholder: false },
            { text: 'organisation', placeholder: true },
            { text: ' (', placeholder: false },
            { text: 'domain A', placeholder: true },
            { text: ')', placeholder: false },
        ]);
        expect(templateParts(null, t)).toEqual([]);
    });
});

describe('identity and feedback', () => {
    it('keys a pattern by its signature and anything else by its id', () => {
        expect(suggestionKey(suggestion())).toBe('sig-1');
        expect(suggestionKey(suggestion({ pattern: null }))).toBe('id:s1');
    });

    it('sends an allow-list of fields, never the prompt or the evidence', () => {
        const body = feedbackSuggestion(suggestion({ buildPrompt: 'mail anne@example.com', evidence: { summary: 'x' }, requiredIntegrations: ['gmail'] }));
        expect(body).toEqual({ id: 's1', title: 'Invoice to sheet', requiredIntegrations: ['gmail'], groundedIn: null, complexity: null });
    });

    it('reads the retry seconds out of a rate-limit message', () => {
        expect(parseRetrySeconds('Too many requests. Retry in ~20s.')).toBe(20);
        expect(parseRetrySeconds('nope')).toBeNull();
    });
});
