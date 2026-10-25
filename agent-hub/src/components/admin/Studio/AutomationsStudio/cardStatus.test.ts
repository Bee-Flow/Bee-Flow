import { describe, expect, it } from 'vitest';
import { cardStatusOf, isCronShapeValid, rowMetaParts, triggerShortOf } from './cardStatus';

const t = ((_k: string, en: string, vars?: Record<string, unknown>) => (vars ? en.replace(/\{(\w+)\}/g, (_, n) => String(vars[n])) : en)) as never;

const live = { id: 'a', isActive: true, isDraft: false, liveVersion: 2, neverLive: false };
const draft = { id: 'b', isActive: false, isDraft: true, liveVersion: null, neverLive: true };
const paused = { id: 'c', isActive: false, isDraft: false, liveVersion: 1, neverLive: false };

describe('cardStatusOf', () => {
    it('reads the lifecycle', () => {
        expect(cardStatusOf(live).lifecycle).toBe('live');
        expect(cardStatusOf(draft).lifecycle).toBe('draft');
        expect(cardStatusOf(paused).lifecycle).toBe('paused');
    });

    it('says nothing about runs on a draft that never ran, "never" where that is news', () => {
        expect(cardStatusOf(draft).outcome).toBeNull();
        expect(cardStatusOf(live).outcome).toBe('never');
        expect(cardStatusOf(paused).outcome).toBe('never');
    });

    it('a live run beats the stored status; both failure spellings fail', () => {
        expect(cardStatusOf({ ...live, lastStatus: 'error' }, true).outcome).toBe('running');
        expect(cardStatusOf({ ...live, lastStatus: 'running' }).outcome).toBe('running');
        expect(cardStatusOf({ ...draft, lastStatus: 'failed' }).outcome).toBe('failed');
        expect(cardStatusOf({ ...live, lastStatus: 'error' }).outcome).toBe('failed');
        expect(cardStatusOf({ ...live, lastStatus: 'success' }).outcome).toBe('ok');
        expect(cardStatusOf({ ...live, lastStatus: 'cancelled' }).outcome).toBe('other');
    });
});

describe('triggerShortOf', () => {
    it('drops the timezone from a schedule and flags a broken one', () => {
        const s = triggerShortOf({ id: 'a', triggerType: 'schedule', scheduleCron: '0 9 * * *', scheduleTz: 'Europe/Amsterdam' }, t);
        expect(s).not.toContain('Europe/Amsterdam');
        expect(s.length).toBeGreaterThan(0);
        expect(triggerShortOf({ id: 'a', triggerType: 'schedule', scheduleCron: 'nonsense' }, t)).toBe('Invalid schedule');
    });

    it('names app events, webhooks and the rest by their tone', () => {
        expect(triggerShortOf({ id: 'a', triggerType: 'app_event', definition: { trigger: { kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'file.new' } } } }, t)).toBe('New file (Nextcloud)');
        expect(triggerShortOf({ id: 'a', triggerType: 'webhook' }, t)).toBe('Webhook');
        expect(triggerShortOf({ id: 'a', triggerType: 'manual' }, t)).toBe('By hand');
        expect(triggerShortOf({ id: 'a', triggerType: 'form' }, t)).toBe('Form');
    });

    it('checks the cron shape', () => {
        expect(isCronShapeValid('*/5 * * * *')).toBe(true);
        expect(isCronShapeValid('0 9 * *')).toBe(false);
        expect(isCronShapeValid(null)).toBe(false);
    });
});

describe('rowMetaParts', () => {
    it('is short: one status word, then the trigger', () => {
        expect(rowMetaParts({ ...draft, triggerType: 'form' }, t).map(p => p.text)).toEqual(['Draft', 'Form']);
        expect(rowMetaParts({ ...live, triggerType: 'manual', pendingChanges: 2 }, t).map(p => p.text)).toEqual(['Live · v2', '2 changes not live', 'By hand']);
    });

    it('a failed last run replaces the trigger', () => {
        const parts = rowMetaParts({ ...paused, triggerType: 'manual', lastStatus: 'error' }, t);
        expect(parts.map(p => p.text)).toEqual(['Paused', 'Last run failed']);
        expect(parts[1].tone).toBe('failed');
    });
});
