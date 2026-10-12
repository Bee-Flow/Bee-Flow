import { describe, expect, it } from 'vitest';

import { carriesKinds, isAuditRow, outcomeOfAction, outcomeOfCall, sumByAction } from './outcomes';
import { deriveEvidence } from './useShieldEvidence';

describe('outcomeOfAction', () => {
    it('maps every stored action the server writes to one outcome', () => {
        for (const a of ['tokenized', 'redacted', 'tool_result_redacted', 'partial_redacted']) {
            expect(outcomeOfAction(a, 'pii')).toBe('replaced');
        }
        for (const a of ['blocked', 'search_blocked', 'tool_blocked', 'held']) expect(outcomeOfAction(a, 'pii')).toBe('stopped');
        for (const a of ['allowed', 'pii_detected', 'passed_unredacted']) expect(outcomeOfAction(a, 'pii')).toBe('passed');
    });

    it('reads the action together with its violation type', () => {
        // An automation told to fail closed: the content never left.
        expect(outcomeOfAction('scan_failed', 'scan_failed')).toBe('stopped');
        // The chat's pre-send check could not run and the message went out unchecked.
        expect(outcomeOfAction('scan_failed', 'dlp_decision')).toBe('passed');
        expect(outcomeOfAction('passed_unredacted', 'scan_failed')).toBe('passed');
        expect(outcomeOfAction('blocked', 'pii_unavailable')).toBe('stopped');
        // Hidden Unicode removed from a prompt is not personal data replaced.
        expect(outcomeOfAction('stripped', 'unicode_smuggling')).toBe('other');
        expect(outcomeOfAction('persist_failed', 'pii_tokenmap')).toBe('other');
    });

    it('never guesses an unknown value into a bucket', () => {
        expect(outcomeOfAction('Added user to scope', 'admin_action')).toBe('other');
        expect(outcomeOfAction(null, null)).toBe('other');
    });
});

describe('carriesKinds', () => {
    it('is false where the categories column holds a note or a marker', () => {
        expect(carriesKinds('pii')).toBe(true);
        expect(carriesKinds('dlp_decision')).toBe(true);
        expect(carriesKinds('regex')).toBe(true);
        for (const type of ['unicode_smuggling', 'pii_tokenmap', 'scan_failed', 'pii_unavailable', 'admin_action']) {
            expect(carriesKinds(type)).toBe(false);
        }
    });
});

describe('outcomeOfCall', () => {
    it('tells a blocked call, one that carried data, a clean one and an unchecked one apart', () => {
        expect(outcomeOfCall('blocked', 2, 'full')).toBe('stopped');
        expect(outcomeOfCall('success', 2, 'full')).toBe('tool');
        expect(outcomeOfCall('success', 0, 'full')).toBe('clean');
        expect(outcomeOfCall('success', 0, 'basic')).toBe('clean');
        // Not looked in is not "no personal data".
        expect(outcomeOfCall('success', 0, 'none')).toBe('unchecked');
        // A row from an older server keeps the old reading.
        expect(outcomeOfCall('success', 0, null)).toBe('clean');
    });
});

describe('sumByAction', () => {
    it('sums per outcome and leaves the configuration-audit rows out', () => {
        const rows = [
            { action_taken: 'tokenized', violation_type: 'pii', count: 40 },
            { action_taken: 'redacted', violation_type: 'pii', count: '8' },
            { action_taken: 'blocked', violation_type: 'dlp_decision', count: 5 },
            { action_taken: 'allowed', violation_type: 'dlp_decision', count: 2 },
            { action_taken: 'scan_failed', violation_type: 'scan_failed', count: 3 },
            { action_taken: 'stripped', violation_type: 'unicode_smuggling', count: 50 },
            // Free text in action_taken; must not land anywhere.
            { action_taken: 'blocked', violation_type: 'admin_action', count: 99 },
        ];
        expect(sumByAction(rows)).toEqual({ replaced: 48, stopped: 8, passed: 2 });
        expect(isAuditRow(rows[6])).toBe(true);
    });
});

describe('deriveEvidence', () => {
    it('reads the two overviews into one set of 30-day figures', () => {
        const ev = deriveEvidence(
            { by_action: [{ action_taken: 'tokenized', count: 3 }, { action_taken: 'tool_blocked', count: 1 }] },
            {
                summary: {
                    pii_events: 12, pii_non_eu_count: 4, total_calls: 50,
                    local_count: 10, eu_count: 20, non_eu_count: 15, via_network_count: 3, unknown_count: 2,
                },
                health: { scan_levels: { full: 30, basic: 5, none: 15 } },
                pii_categories: [
                    { category: 'Email', count: 7 }, { category: 'Person', count: 9 },
                    { category: 'Phone', count: 1 }, { category: 'IBAN', count: 2 },
                ],
            },
        );
        expect(ev).toMatchObject({
            replaced: 3, stopped: 1, passed: 0, toolPii: 12, piiNonEuCount: 4, totalCalls: 50, scannedCalls: 35,
            local: 10, eu: 20, outside: 15, viaNetwork: 3, unknown: 2, days: 30,
        });
        expect(ev.toolKinds).toEqual({ Email: 7, Person: 9, Phone: 1, IBAN: 2 });
        expect(ev.topToolKinds).toEqual(['Person', 'Email', 'IBAN']);
    });

    it('reads an older server that omits fields as zero, not as a crash', () => {
        expect(deriveEvidence({}, {})).toMatchObject({ toolPii: 0, totalCalls: 0, scannedCalls: 0, toolKinds: {}, topToolKinds: [] });
    });
});
