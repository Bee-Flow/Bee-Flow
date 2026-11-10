import { describe, expect, it } from 'vitest';
import { isSimulatedWrite, simulatedResultText, simulatedWriteKind } from './simulatedStep';

const row = (stepType: string, output: unknown, status = 'success') => ({ stepType, status, output });

describe('simulatedWriteKind', () => {
    it.each([
        ['notification', { _dryRun: true, wouldNotify: ['bell'] }, 'send'],
        ['http_request', { status: 200, ok: true, body: '{}', data: {}, _dryRun: true, _dryRunSynthesised: true, _dryRunFallback: null }, 'send'],
        ['integration_action', { id: 'sample', _dryRunSynthesised: true, _dryRunFallback: null }, 'act'],
        ['knowledge_write', { written: false, wouldWrite: true, _dryRunSynthesised: true, _dryRunFallback: null }, 'write'],
        ['datatable', { row: { a: 1 }, id: null, created: true, updated: 0, _dryRunSynthesised: true }, 'write'],
        ['datatable', { deleted: 0, _dryRunSynthesised: true }, 'write'],
        ['generate_document', { fileName: 'a.docx', _dryRun: true, _dryRunSynthesised: true, _dryRunFallback: null }, 'write'],
        ['fill_document', { _dryRun: true, _dryRunSynthesised: true, _dryRunFallback: null }, 'write'],
    ])('a dry-run %s that was held back is "%s"', (type, output, kind) => {
        expect(simulatedWriteKind(row(type, output))).toBe(kind);
        expect(isSimulatedWrite(row(type, output))).toBe(true);
    });

    it.each([
        ['a read tool that answered sample data', row('integration_action', { items: [], _dryRunSynthesised: true, _dryRunFallback: 'not_connected' })],
        ['a read tool fed by simulated input', row('integration_action', { items: [], _dryRunSynthesised: true, _dryRunFallback: 'synthetic_input' })],
        ['a read of a table that is only proposed', row('datatable', { rows: [], returned: 0, count: 0, found: false, _dryRunSynthesised: true, _pendingTable: 'pending:1' })],
        ['a plain GET that really ran', row('http_request', { status: 200, ok: true, data: { a: 1 } })],
        ['a step of a live run', row('notification', { delivered: ['bell'] })],
        ['a transform that only previews', row('table', { rows: [], _dryRun: true })],
        ['a write a live run would refuse', row('integration_action', { skipped: 'Not simulated', _dryRunSynthesised: true, _dryRunFallback: 'not_permitted' }, 'skipped')],
        ['a failed step', row('notification', { _dryRun: true }, 'error')],
        ['a row without an output', row('notification', null)],
        ['an output that is a list', row('integration_action', [{ _dryRunSynthesised: true }])],
        ['no row at all', null],
    ])('%s is not a simulated write', (_name, step) => {
        expect(simulatedWriteKind(step)).toBeNull();
        expect(isSimulatedWrite(step)).toBe(false);
    });
});

describe('simulatedResultText', () => {
    const t = (_key: string, fallback: string) => fallback;
    it('says what did not happen, per kind', () => {
        expect(simulatedResultText('send', t)).toBe('not sent');
        expect(simulatedResultText('write', t)).toBe('not written');
        expect(simulatedResultText('act', t)).toBe('not carried out');
    });
});
