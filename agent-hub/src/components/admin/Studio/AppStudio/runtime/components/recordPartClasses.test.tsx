import { render } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ComponentType, ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import snapshot from '../catalogSnapshot.generated.json';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import AppBadgeList from './AppBadgeList';
import AppMessageThread from './AppMessageThread';
import AppProgress from './AppProgress';
import AppRecordDetail from './AppRecordDetail';
import AppStepper from './AppStepper';
import AppTimeline from './AppTimeline';
import { RECORD_FAMILY_TYPES, declaredParts, expectPartsMatch } from './recordPartClassKit';

/**
 * LK7b, record family (display half): the stable part classes `bfa-<type>__<part>`
 * an app's custom CSS can aim at. The parts a type declares in the spec are exactly
 * the ones that render. The fetching types are in recordPartClasses.fetch.test.tsx
 * and the document types in recordPartClasses.documents.test.tsx.
 */

const NOW = '2026-01-01T00:00:00.000Z';

function mount(Component: ComponentType<{ node: never }>, node: Record<string, unknown>, runtime: Record<string, unknown> = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: NOW }), mode: 'run', ...runtime } as never;
    const ui: ReactElement = <RuntimeProvider value={value}><Component node={node as never} /></RuntimeProvider>;
    return render(ui).container;
}

const stat = (value: unknown) => ({ kind: 'static', value });
const base = (type: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: `cmp_${type}`, type, visible: true, props, style: { span: 12 }, ...extra,
});

describe('part classes: record display types', () => {
    it('badge_list', () => {
        const items = [{ label: 'Open', n: 3 }, { label: 'Done', n: 1 }];
        expectPartsMatch('badge_list', [mount(AppBadgeList, base('badge_list', { source: stat(items), countKey: 'n' }))]);
    });

    it('progress (bar, segments and ring)', () => {
        const bar = mount(AppProgress, base('progress', { value: stat(40), max: stat(100), label: 'Done', format: 'percent' }));
        const segments = mount(AppProgress, base('progress', {
            value: stat(0), label: 'Mix', segments: [{ value: stat(2), tone: 'success' }, { value: stat(1), tone: 'warning' }],
        }));
        const ring = mount(AppProgress, base('progress', { value: stat(50), label: 'Ring', look: 'ring', format: 'percent' }));
        expectPartsMatch('progress', [bar, segments, ring]);
    });

    it('stepper', () => {
        const steps = [
            { value: 'new', label: 'New', hint: stat('waiting on a material') },
            { value: 'open', label: 'Open' },
            { value: 'done', label: 'Done' },
        ];
        expectPartsMatch('stepper', [mount(AppStepper, base('stepper', { value: stat('open'), steps, orientation: 'horizontal', showLabels: true }))]);
    });

    it('timeline', () => {
        const rows = [{ title: 'Created', at: '2026-01-01', detail: 'first', by: 'Ann' }, { title: 'Closed', at: '2026-01-02', detail: 'last', by: 'Tom' }];
        const props = { source: stat(rows), titleKey: 'title', dateKey: 'at', descriptionKey: 'detail', metaKey: 'by' };
        expectPartsMatch('timeline', [
            mount(AppTimeline, base('timeline', props)),
            mount(AppTimeline, base('timeline', props, { onRowClick: 'act_x' })),
        ]);
    });

    it('message_thread', () => {
        const rows = [
            { id: 'm1', kind: 'a', author: 'Jan', body: 'Hello', at: '2026-03-01T09:00:00Z' },
            { id: 'm2', kind: 'b', author: 'Ann', body: 'Hi', at: '2026-03-01T09:12:00Z' },
        ];
        const sideMap = [{ value: 'a', side: 'left', tone: 'neutral' }, { value: 'b', side: 'right', tone: 'primary' }];
        const chat = mount(AppMessageThread, base('message_thread', { source: stat(rows), sideField: 'kind', timestampField: 'at', sideMap }));
        const mail = mount(AppMessageThread, base('message_thread', { source: stat(rows), sideField: 'kind', timestampField: 'at', sideMap, showAvatar: true }));
        expectPartsMatch('message_thread', [chat, mail]);
    });

    it('record_detail (stacked and rows)', () => {
        const record = { name: 'Audit', amount: 5, status: 'open' };
        const fields = [{ key: 'name', label: 'Name', group: 'Main' }, { key: 'amount', label: 'Amount', format: 'number' }, { key: 'status', label: 'Status' }];
        const stacked = mount(AppRecordDetail, base('record_detail', { source: stat(record), fields }));
        const rows = mount(AppRecordDetail, base('record_detail', { source: stat(record), fields, layout: 'rows' }));
        expectPartsMatch('record_detail', [stacked, rows]);
    });
});

describe('part classes: the family as a whole', () => {
    const require = createRequire(import.meta.url);
    const specs = require('../../../../../../../../server/appStudio/componentSpecs.js') as { COMPONENT_SPECS: Record<string, { parts?: string[] }> };
    const snap = snapshot as unknown as { types: Record<string, { parts?: string[] }> };

    it('declares 3 to 8 lowercase parts per type, starting with root, and the web snapshot carries the same list', () => {
        for (const type of RECORD_FAMILY_TYPES) {
            const parts = declaredParts(type);
            expect(parts[0], type).toBe('root');
            expect(parts.length, type).toBeGreaterThanOrEqual(3);
            expect(parts.length, type).toBeLessThanOrEqual(8);
            expect(new Set(parts).size, type).toBe(parts.length);
            for (const part of parts) expect(part, type).toMatch(/^[a-z]+(-[a-z]+)*$/);
            expect(snap.types[type]?.parts, `${type} in the web snapshot`).toEqual(parts);
            expect(specs.COMPONENT_SPECS[type]?.parts).toEqual(parts);
        }
    });

    it('no product stylesheet references a part class (only an app\'s own CSS may)', () => {
        const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../..');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const full = path.join(dir, name);
                if (statSync(full).isDirectory()) walk(full);
                else if (name.endsWith('.css') && readFileSync(full, 'utf8').includes('bfa-')) offenders.push(path.relative(root, full));
            }
        };
        walk(root);
        expect(offenders).toEqual([]);
    });
});
