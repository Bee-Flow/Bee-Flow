import { describe, expect, it } from 'vitest';
import { describeTriggerMeta } from './triggers';
import { computeUpstreamGroups } from './groups';

// The server's catalog.triggerMeta (TRIGGER_META_FIELDS), samples included —
// those samples are examples from an app-event / schedule trigger.
const CATALOG = {
    triggerMeta: [
        { key: 'kind', path: 'trigger.kind', sample: 'app_event' },
        { key: 'source', path: 'trigger.source', sample: 'app_event' },
        { key: 'id', path: 'trigger.id', sample: 'trg' },
        { key: 'label', path: 'trigger.label', sample: 'New mail' },
        { key: 'provider', path: 'trigger.provider', sample: 'gmail' },
        { key: 'event', path: 'trigger.event', sample: 'mail.new' },
        { key: 'firedAt', path: 'trigger.firedAt', sample: '2026-09-03T07:00:00.000Z' },
        { key: 'schedule.cron', path: 'trigger.schedule.cron', sample: '0 7 * * 1-5' },
        { key: 'schedule.scheduledFor', path: 'trigger.schedule.scheduledFor', sample: '2026-09-03T07:00:00.000Z' },
    ],
    triggerOutputs: { __manual: { fields: [], sample: {} } },
};

type Field = { key: string; sample: unknown };
type Meta = { fields: Field[] };
const keys = (g: Meta) => g.fields.map(f => f.key);
/** describeTriggerMeta, asserted present (it returns null when nothing applies). */
function meta(def: unknown): Meta {
    const g = describeTriggerMeta(def as never, CATALOG) as Meta | null;
    expect(g).not.toBeNull();
    return g as Meta;
}
const field = (g: Meta, key: string) => g.fields.find((f: Field) => f.key === key) as Field;

describe('describeTriggerMeta only lists what the actual trigger produces', () => {
    it('manual: no label, provider, event or schedule fields', () => {
        const g = meta({ trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] });
        expect(keys(g)).toEqual(['kind', 'source', 'id', 'firedAt']);
        expect(JSON.stringify(g.fields)).not.toContain('New mail');
        expect(JSON.stringify(g.fields)).not.toContain('0 7 * * 1-5');
    });

    it('form: the same shared fields, nothing borrowed from other kinds', () => {
        const g = meta({ trigger: { id: 'trg', kind: 'form' }, steps: [], edges: [] });
        expect(keys(g)).toEqual(['kind', 'source', 'id', 'firedAt']);
    });

    it('schedule: adds the cron, with its own value', () => {
        const g = meta({ trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '*/5 * * * *' } } });
        expect(keys(g)).toEqual(['kind', 'source', 'id', 'firedAt', 'schedule.cron']);
        expect(field(g, 'schedule.cron').sample).toBe('*/5 * * * *');
    });

    it('app event: adds provider and event from the trigger, not the catalog example', () => {
        const g = meta({ trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'slack', event: 'message.new' } } });
        expect(keys(g)).toEqual(['kind', 'source', 'id', 'provider', 'event', 'firedAt']);
        expect(field(g, 'provider').sample).toBe('slack');
    });

    it('a label shows up once the trigger has one', () => {
        const g = meta({ trigger: { id: 'trg', kind: 'manual', label: 'Start' } });
        expect(keys(g)).toContain('label');
        expect(field(g, 'label').sample).toBe('Start');
    });

    it('an additional schedule trigger brings the schedule fields along', () => {
        const g = meta({ trigger: { id: 'trg', kind: 'manual' }, triggers: [{ id: 't2', kind: 'schedule' }] });
        expect(keys(g)).toEqual(expect.arrayContaining(['schedule.cron', 'schedule.scheduledFor']));
    });

    it('flows through computeUpstreamGroups too', () => {
        const def = {
            trigger: { id: 'trg', kind: 'manual' },
            steps: [{ id: 'n1', type: 'notification', title: 'x' }],
            edges: [{ from: 'trg', to: 'n1' }],
        };
        const group = (computeUpstreamGroups(def as never, 'n1', CATALOG) as Array<Meta & { kind?: string }>).find(g => g.kind === 'trigger_meta') as Meta;
        expect(keys(group)).toEqual(['kind', 'source', 'id', 'firedAt']);
    });
});
