/**
 * nowRunning.ts held to the web's nowRunning.js on the same facets — the
 * strip's lines, their order, the hidden count and, above all, the rule that
 * an unreadable rollup is null rather than an empty strip.
 *
 * When this fails, the web side changed: update nowRunning.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import { NOW_RUNNING_LIMIT, NOW_RUNNING_TONES, nowRunningLines, readRollups } from './nowRunning';
import type { RunFacets } from './types';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Runs/nowRunning.js');
const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

const roll = (id: string, status: Record<string, number | string>, extra: Record<string, unknown> = {}) => ({
    automationId: id,
    title: `Automation ${id}`,
    kind: 'automation',
    total: Object.values(status).reduce<number>((a, b) => a + Number(b), 0),
    status,
    lastRunAt: `2026-09-24T0${id.length}:00:00Z`,
    lastErrorAt: null,
    lastErrorClass: null,
    ...extra,
});

const FACETS: unknown[] = [
    null,
    undefined,
    [],
    {},
    { automations: null },
    { automations: [] },
    { automations: [roll('a', { success: 3 })] },
    {
        automations: [
            roll('a', { success: 3 }),
            roll('bb', { error: 1, success: 2 }, { lastErrorAt: '2026-09-24T09:00:00Z', lastErrorClass: 'timeout' }),
            roll('ccc', { awaiting_form: 1, awaiting_confirm: 2 }),
            roll('dddd', { running: 1, queued: '2' }),
            roll('e', {}, { title: '   ', kind: 'block' }),
            { automationId: '', total: 4 },
            null,
        ],
        automationsTotal: 55,
    },
    { automations: Array.from({ length: 9 }, (_, i) => roll(`r${i}`, { success: i + 1 })), automationsTotal: 3 },
];

describeIfWeb('nowRunning matches the web', () => {
    const web = () => loadWebModule<{
        NOW_RUNNING_LIMIT: number;
        NOW_RUNNING_TONES: readonly string[];
        nowRunningLines: (facets: unknown) => unknown;
        readRollups: (facets: unknown) => unknown;
    }>(WEB);

    it('shares the limit and the tone ranking', () => {
        expect(NOW_RUNNING_LIMIT).toBe(web().NOW_RUNNING_LIMIT);
        expect([...NOW_RUNNING_TONES]).toEqual([...web().NOW_RUNNING_TONES]);
    });

    it('draws the same strip from the same facets', () => {
        for (const facets of FACETS) {
            expect({ facets, model: nowRunningLines(facets as RunFacets) }).toEqual({ facets, model: web().nowRunningLines(facets) });
            expect(readRollups(facets as RunFacets) === null).toBe(web().readRollups(facets) === null);
        }
    });
});
