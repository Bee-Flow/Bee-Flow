/**
 * Differential lockstep: core/logicRows (+ core/logic/*) against the web's
 * editor/logicRows.js, inspector/actionLabels.js, editor/nodeLogicSummary.js
 * and inspector/styleKnobMeta.js, on every fixture, with and without a
 * translator and an automation-title lookup.
 */

import * as port from './logicRows';
import { EN_ONLY, type Translate } from './msg';
import { allFixtures } from './testing/fixtures';
import { loadWeb } from './testing/loadWeb';
import type { AppDefinition } from './types';

type AnyFn = (...args: unknown[]) => unknown;
const web = loadWeb<Record<string, AnyFn>>('editor/logicRows.js');
const webLabels = loadWeb<Record<string, AnyFn>>('inspector/actionLabels.js');
const webSummary = loadWeb<Record<string, AnyFn>>('editor/nodeLogicSummary.js');
const webKnobs = loadWeb<Record<string, unknown>>('inspector/styleKnobMeta.js');

const fixtures = allFixtures();
const titleFor = (id: unknown) => (id === 'auto_1' ? 'Nightly import' : null);
/** A translator that marks what it translated, so a key mix-up shows. */
const shout: Translate = (key, en, params) => `[${key}] ${EN_ONLY(key, en, params)}`;

describe.each(Object.entries(fixtures))('logic rows on %s', (_name, def) => {
    it('builds the same rows, counts and notices', () => {
        for (const opts of [undefined, { titleFor }]) {
            expect(port.logicRows(def, opts as never)).toEqual(web.default?.(def, opts));
        }
        // With a translator the web still names actions in English (its
        // describeAction takes no t); the port translates them too, under
        // mobile.app_studio.action.*. Everything else is the same text.
        const translated = JSON.stringify(port.logicRows(def, { titleFor, t: shout })).replace(
            /\[mobile\.app_studio\.action\.[a-z_]+\] /g,
            '',
        );
        expect(JSON.parse(translated)).toEqual(web.default?.(def, { titleFor, t: shout }));
        expect(port.countWiredLogic(def)).toBe(web.countWiredLogic?.(def));
        const rows = port.logicRows(def);
        const notices = [
            ...rows.map((r) => ({ path: r.path, code: 'same' })),
            ...rows.map((r) => ({ path: `${r.path}.deeper`, code: 'deep' })),
            ...rows.map((r) => ({ path: r.path.replace(/\.[^.]*$/, ''), code: 'above' })),
            { path: 'meta.name' }, { path: 5 }, null,
        ];
        expect(port.assignNotices(rows, notices)).toEqual(web.assignNotices?.(rows, notices));
        for (const row of rows) expect(port.noticesForRow(notices, row)).toEqual(web.noticesForRow?.(notices, row));
    });

    it('describes every action the same way', () => {
        for (const [id, action] of Object.entries(def.actions || {})) {
            expect(port.describeAction(id, action, def)).toBe(webLabels.describeAction?.(id, action, def));
            expect(port.describeAction(id, action, def, { titleFor })).toBe(webLabels.describeAction?.(id, action, def, titleFor));
        }
        expect(port.actionOptions(def, { titleFor })).toEqual(webLabels.actionOptions?.(def, titleFor));
        expect([...port.collectBoundTableIds(def)]).toEqual([...(web.collectBoundTableIds?.(def) as Set<string>)]);
    });
});

describe('the pieces agree', () => {
    it('describes odd actions the same way', () => {
        const def = fixtures.WIRED as AppDefinition;
        const odd = [
            null, {}, { kind: 'toast' }, { kind: 'toast', message: 'A very long message that is cut off here' },
            { kind: 'open_url' }, { kind: 'open_url', url: 'https://x.test' }, { kind: 'navigate', screenId: 'scr_nope' },
            { kind: 'close_modal', modalId: 'cmp_mod001' }, { kind: 'open_modal', modalId: 'cmp_nope' }, { kind: 'open_modal' },
            { kind: 'sequence', steps: [{}] }, { kind: 'sequence', steps: [] }, { kind: 'sequence' },
            ...['send_email', 'create_record', 'ai_extract', 'ai_generate', 'kb_query', 'mystery', 'run_automation'].map((kind) => ({ kind })),
        ];
        for (const action of odd) {
            expect(port.describeAction('act_x', action as never, def)).toBe(webLabels.describeAction?.('act_x', action, def));
            expect(port.describeAction('act_x', action as never, def, { titleFor: () => 'T' })).toBe(webLabels.describeAction?.('act_x', action, def, () => 'T'));
        }
    });

    it('event lists, slots and words', () => {
        expect(port.TYPE_EVENT_LISTS).toEqual(webKnobs.TYPE_EVENT_LISTS);
        for (const event of ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange', 'onDecided', 'onHover']) {
            expect(port.eventText(EN_ONLY, event)).toBe(webSummary.eventText?.(EN_ONLY, event));
            expect(port.eventText(shout, event)).toBe(webSummary.eventText?.(shout, event));
        }
        for (const type of [...Object.keys(port.TYPE_EVENT_LISTS), 'text', undefined, 'constructor']) {
            expect(port.eventsForType(type)).toEqual(web.eventsForType?.(type));
            const node = { id: 'n', type, onChange: 'act_a', onClick: '', onDecided: 'act_b' };
            expect(port.eventSlotsOf(node as never)).toEqual(web.eventSlotsOf?.(node));
        }
    });

    it('automation rows and the table walk', () => {
        const automationRows = {
            a: { id: 'a', projectId: 'p1', title: 'Import', definition: { trigger: { kind: 'schedule', filter: { tableId: 'tbl_x' } } } },
            b: { id: 'b', projectId: 'p1', triggerType: 'webhook', definition: { steps: [{ kind: 'loop', steps: [{ kind: 'switch', cases: [null, { steps: [{ datatableKey: 'tbl_y' }] }] }] }] } },
            c: { id: 'c', projectId: 'p2', definition: { steps: [{ tableId: 'tbl_x' }] } },
            d: { id: 'd', projectId: 'p1', definition: { steps: [{ kind: 'condition', else: [{ datatableId: 'tbl_x' }] }] } },
            e: { id: 'e', projectId: 'p1', definition: { trigger: { kind: 'agent_call' }, steps: [{ tableId: 'tbl_z' }] } },
            f: { projectId: 'p1' },
        };
        const cases = [
            {}, { app: { projectId: 'p1' } },
            { app: { projectId: 'p1' }, automationRows, boundTableIds: ['tbl_x', 'tbl_y'] },
            { app: { projectId: 'p1' }, automationRows, boundTableIds: new Set(['tbl_x', 'tbl_y', 'tbl_z']), wiredAutomationIds: ['d'] },
            { app: { projectId: 'p1' }, automationRows, boundTableIds: new Set(['tbl_x']), t: shout },
            { app: { projectId: null }, automationRows, boundTableIds: ['tbl_x'] },
        ];
        for (const args of cases) expect(port.derivedAutomationRows(args as never)).toEqual(web.derivedAutomationRows?.(args));
        for (const row of Object.values(automationRows)) {
            for (const tables of [new Set(['tbl_x']), new Set(['tbl_y']), new Set(), ['tbl_x']]) {
                expect(port.automationTouchesTables(row as never, tables)).toBe(web.automationTouchesTables?.(row, tables));
            }
        }
    });

    it('exports every name the web module exports', () => {
        const missing = Object.keys(web).filter((k) => k !== 'default' && !(k in port));
        expect(missing).toEqual([]);
    });
});
