import { describe, expect, it } from 'vitest';
import type { Pattern, RepeatingSuggestion } from '../../api/queries/automation/repeating';
import { buildMessageFromPattern, cadenceHint } from './patternMessage';
import { buildMessageFromSuggestion } from './taskFormatters';

const pattern = (over: Partial<Pattern> = {}): Pattern => ({
    kind: 'mail_template',
    signature: 'sig-1',
    cadence: { kind: 'weekly', weekday: 1, hourBand: [9, 10], perMonth: 4, weeksPresent: 5, weeksWindow: 6 },
    occurrences: 14,
    windowDays: 90,
    distinctDays: 9,
    weekdayHistogram: [0, 9, 2, 1, 1, 1, 0],
    minutesPerMonth: [60, 120],
    basis: 'heuristic',
    template: 'Invoice <n> from <org>',
    apps: ['gmail', 'google-sheets'],
    draft: {
        trigger: { kind: 'app', app: 'gmail', provider: 'gmail', event: 'mail.new', label: 'New email in Gmail' },
        steps: [
            { family: 'ai', label: 'Extract the details' },
            { family: 'app', app: 'google-sheets', label: 'Append rows' },
        ],
    },
    reasons: ['frequent', 'regular'],
    confidence: 'normal',
    ...over,
});

const suggestion = (over: Partial<RepeatingSuggestion> = {}): RepeatingSuggestion => ({
    id: 's1',
    title: 'Log invoices in a sheet',
    buildPrompt: 'When an invoice e-mail arrives, add its number and amount to the invoices sheet.',
    requiredIntegrations: ['gmail', 'google-sheets'],
    unavailableIntegrations: [],
    pattern: pattern(),
    ...over,
});

describe('buildMessageFromPattern', () => {
    it('starts with the build prompt and adds the measured pattern after it', () => {
        const msg = buildMessageFromPattern(suggestion());
        const lines = msg.split('\n');
        expect(lines[0]).toBe('When an invoice e-mail arrives, add its number and amount to the invoices sheet.');
        expect(lines[1]).toBe('');
        expect(lines[2]).toMatch(/^Context from the "Find repeating work" scan/);
        expect(msg).toContain('- What repeats: e-mails that follow the same template');
        expect(msg).toContain('- Seen 14 times in the last 90 days, on 9 different days, in 5 of 6 weeks.');
        expect(msg).toContain('- Apps to use: gmail, google-sheets');
        expect(msg).toContain('- Time this takes now: about 60–120 min per month (estimated)');
    });

    it('names the draft trigger with its declared app event, and the steps in order', () => {
        const msg = buildMessageFromPattern(suggestion());
        expect(msg).toContain('- Suggested trigger: New email in Gmail (app event gmail / mail.new)');
        expect(msg).toContain('- Suggested steps:\n  1. Extract the details (AI step)\n  2. Append rows (google-sheets)');
        // An app trigger starts it: the rhythm is only context, not a schedule to build.
        expect(msg).toContain('- Rhythm, for reference: this usually happens every week on Monday at 09:00.');
        expect(msg).not.toContain('Schedule hint');
    });

    it('turns the cadence into a schedule hint when the draft starts on a schedule', () => {
        const msg = buildMessageFromPattern(suggestion({
            pattern: pattern({ kind: 'sequence', draft: { trigger: { kind: 'schedule', label: 'Every week on Monday at 09:00' }, steps: [] } }),
        }));
        expect(msg).toContain('- Suggested trigger: a schedule (Every week on Monday at 09:00)');
        expect(msg).toContain('- Schedule hint: run it every week on Monday at 09:00, when this work usually happens.');
        expect(msg).not.toContain('Suggested steps');
    });

    it('without a draft, a regular rhythm still suggests a schedule; an irregular one asks', () => {
        const regular = buildMessageFromPattern(suggestion({ pattern: pattern({ draft: null, cadence: { kind: 'daily' } }) }));
        expect(regular).toContain('- Suggested trigger: a schedule\n');
        expect(regular).toContain('- Schedule hint: run it every day, when this work usually happens.');
        const irregular = buildMessageFromPattern(suggestion({ pattern: pattern({ draft: null, cadence: { kind: 'irregular' } }) }));
        expect(irregular).toContain('- Trigger: the scan found none that fits; ask which one to use.');
        expect(irregular).not.toContain('Schedule hint');
    });

    it('keeps the template with its placeholders, and explains an anonymous domain', () => {
        expect(buildMessageFromPattern(suggestion())).toContain('- Template (the parts in <angle brackets> change each time): "Invoice <n> from <org>"');
        const domain = buildMessageFromPattern(suggestion({ pattern: pattern({ template: 'Order <id> from <domain:A>' }) }));
        expect(domain).toContain('<domain:A> stands for one sender\'s domain, kept anonymous. "Order <id> from <domain:A>"');
        expect(buildMessageFromPattern(suggestion({ pattern: pattern({ template: null }) }))).not.toContain('Template');
    });

    it('leaves out every figure the miner did not measure, and marks an early signal', () => {
        const msg = buildMessageFromPattern(suggestion({
            pattern: pattern({ occurrences: 0, minutesPerMonth: null, apps: [], confidence: 'early' }),
            requiredIntegrations: ['outlook'],
        }));
        expect(msg).not.toContain('Seen');
        expect(msg).not.toContain('Time this takes');
        expect(msg).toContain('- Apps to use: outlook');
        const early = buildMessageFromPattern(suggestion({ pattern: pattern({ confidence: 'early', basis: 'measured' }) }));
        expect(early).toContain('(an early signal: there is little history yet).');
        expect(early).toContain('(measured from the sessions)');
    });

    it('names the apps that still need a connection', () => {
        const msg = buildMessageFromPattern(suggestion({ unavailableIntegrations: ['google-sheets'] }));
        expect(msg).toContain('- Not yet connected (mention if a connection is needed): google-sheets');
    });

    it('writes a plain prompt from the title when the scan wrote none', () => {
        const msg = buildMessageFromPattern(suggestion({ buildPrompt: '', description: 'Every Monday morning.' }));
        expect(msg.split('\n')[0]).toBe('Build an automation for this repeating work: Log invoices in a sheet. Every Monday morning.');
    });

    it('an idea (no pattern) gets the older suggestion message unchanged', () => {
        const idea = suggestion({ pattern: null, triggerKind: 'schedule', evidence: { summary: 'You search Gmail often' } });
        expect(buildMessageFromPattern(idea)).toBe(buildMessageFromSuggestion(idea));
        expect(buildMessageFromPattern(idea)).toContain('- Suggested trigger: schedule');
        expect(buildMessageFromPattern(null)).toBe('');
    });
});

describe('cadenceHint', () => {
    it('reads each regular rhythm as a schedule, with the day and hour when known', () => {
        expect(cadenceHint({ kind: 'weekdays', hourBand: [8, 9] })).toBe('every weekday (Monday to Friday) at 08:00');
        expect(cadenceHint({ kind: 'biweekly', weekday: 5 })).toBe('every two weeks on Friday');
        expect(cadenceHint({ kind: 'monthly' })).toBe('once a month');
        expect(cadenceHint({ kind: 'weekly' })).toBe('every week');
    });

    it('gives no schedule for an irregular or unknown rhythm', () => {
        expect(cadenceHint({ kind: 'irregular' })).toBeNull();
        expect(cadenceHint({ kind: 'hourly' })).toBeNull();
        expect(cadenceHint(null)).toBeNull();
    });
});
