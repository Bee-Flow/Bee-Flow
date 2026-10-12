import { describe, expect, it } from 'vitest';
import { parseCell, parseConfig, parseRopa, parseSummary, refusalOf } from './useChatMonitoring';

/**
 * The allow-lists of the chat-signals card's one client module. The card
 * renders only what these readers let through, so a figure is a number,
 * "<5", "hidden" or "not applicable", and nothing else ever reaches a cell.
 */

describe('parseCell', () => {
    it('lets through numbers, "<5" and "hidden"; null is "not applicable"; anything else is hidden', () => {
        expect(parseCell(37)).toBe(37);
        expect(parseCell(0)).toBe(0);
        expect(parseCell('<5')).toBe('<5');
        expect(parseCell('hidden')).toBe('hidden');
        expect(parseCell(null)).toBeNull();
        expect(parseCell('3')).toBe('hidden');
        expect(parseCell(-1)).toBe('hidden');
        expect(parseCell({ raw: 3 })).toBe('hidden');
    });
});

describe('parseSummary', () => {
    it('keeps known chat types in vocabulary order and drops a health row', () => {
        const s = parseSummary({
            window: { days: 30 },
            surfaces: {
                agent_public: { status: 'shown', turns: 12, pct: { scanned: 100 }, kinds: { status: 'off' } },
                direct: { status: 'shown', turns: '<5', pct: { blocked: '<5' }, kinds: { status: 'shown', rows: { email: { protected: 6, exposed: 0 }, health: { protected: 9, exposed: 9 } } } },
                project_chat: { status: 'shown', turns: 99 },
            },
        });
        expect(s.surfaces.map((x) => x.surface)).toEqual(['direct', 'agent_public']);
        expect(s.surfaces[0].figures.kinds.rows).toEqual([{ kind: 'email', protected: 6, exposed: 0 }]);
        expect(s.surfaces[0].figures.turns).toBe('<5');
    });

    it('a chat type without a complete period reads as such, with no figures', () => {
        const s = parseSummary({ surfaces: { direct: { status: 'no_full_period' } } });
        expect(s.surfaces[0].figures).toMatchObject({ status: 'no_full_period', turns: null, pct: {} });
    });
});

describe('parseConfig', () => {
    it('allow-lists the settings and falls back to the client vocabulary for a missing catalogue', () => {
        const c = parseConfig({
            settings: { enabled: true, surfaces: ['direct', 'project_chat'], signals: ['outcomes', 'special_kinds'], retention_days: 60, legal_basis: 'art9', enabled_by: 'u-1' },
            effective: { state: 'on', paused: [{ surface: 'agent', missing: ['dpia', 'Not A Code'] }] },
            contributors: { direct: '10-24', agent: null },
            can_widen: 'yes',
        });
        expect(c.settings).toMatchObject({ enabled: true, surfaces: ['direct'], signals: ['outcomes'], retention_days: 60, legal_basis: null });
        expect(c.settings).not.toHaveProperty('enabled_by');
        expect(c.effective.paused).toEqual([{ surface: 'agent', missing: ['dpia'] }]);
        expect(c.contributors).toEqual({ direct: '10-24' });
        expect(c.catalogue.surfaces.map((s) => s.id)).toEqual(['direct', 'agent', 'agent_public', 'notebook']);
        expect(c.canWiden).toBe(false);
    });
});

describe('parseRopa and refusalOf', () => {
    it('picks only the chat-signals activity, and the controller name unless it is the org id', () => {
        const r = parseRopa({
            organization_id: 'org1',
            controller: { name: 'Acme' },
            activities: [{ activity_id: 'agent-1', name: 'Other' }, { activity_id: 'chat-compliance-signals', name: 'Chat signals', data_subjects: ['A', 3] }],
        });
        expect(r.controllerName).toBe('Acme');
        expect(r.activity).toMatchObject({ name: 'Chat signals', data_subjects: ['A'] });
        expect(parseRopa({ organization_id: 'default', controller: { name: 'default' }, activities: [] })).toEqual({ activity: null, controllerName: null });
    });

    it('reads the status, the code and only well-formed missing codes', () => {
        const e = Object.assign(new Error('422 Unprocessable Entity'), { status: 422, code: 'chat_monitoring_preconditions', details: { missing: ['dpia', 'works_council', 42, 'DROP TABLE'] } });
        expect(refusalOf(e)).toEqual({ status: 422, code: 'chat_monitoring_preconditions', missing: ['dpia', 'works_council'] });
        expect(refusalOf(new Error('network'))).toEqual({ status: null, code: null, missing: [] });
    });
});
