import type { FlowNode } from '@/features/flow-editor/bindings';

import { configOf, configText, parseConfig } from './jsonConfig';

const STEP: FlowNode = {
    id: 'c1',
    type: 'code',
    label: 'Sum',
    position: { x: 1, y: 2 },
    pinnedOutput: { total: 3 },
    code: 'return 1',
    inputs: { a: { kind: 'literal', value: 1 } },
};

describe('the JSON view of a step', () => {
    it('shows only the configuration', () => {
        expect(configOf(STEP)).toEqual({ code: 'return 1', inputs: { a: { kind: 'literal', value: 1 } } });
        expect(JSON.parse(configText(STEP))).toEqual(configOf(STEP));
    });

    it('turns the edited JSON into a patch that removes what was deleted', () => {
        expect(parseConfig(STEP, '{"code":"return 2"}')).toEqual({ ok: true, patch: { code: 'return 2', inputs: undefined } });
    });

    it('refuses broken JSON, a non-object and a reserved key', () => {
        expect(parseConfig(STEP, '{oops')).toMatchObject({ ok: false, reason: 'invalid' });
        expect(parseConfig(STEP, '[1]')).toEqual({ ok: false, reason: 'not_object' });
        expect(parseConfig(STEP, 'null')).toEqual({ ok: false, reason: 'not_object' });
        expect(parseConfig(STEP, '{"type":"set"}')).toEqual({ ok: false, reason: 'reserved', key: 'type' });
    });
});
