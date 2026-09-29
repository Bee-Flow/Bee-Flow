import { describe, it, expect } from 'vitest';

import { dispatchSSEEvent } from './sseEvents';

/**
 * De `phase`-events op de chatkant, nu ze twee dingen moeten doen.
 *
 * De LIVE REGEL (`currentPhase`) is met opzet vluchtig: elke fase overschrijft
 * de vorige, en de eerste letter van het antwoord wist hem. Het SPOOR
 * (`phaseTrail`, A4 deel C) is het tegenovergestelde en moet blijven staan.
 *
 * Wat hier getest wordt is de plek waar die twee uit elkaar lopen: de live
 * regel laat een `end` vallen die niet bij de huidige fase hoort — juist, want
 * `guardrails` sluit ná `privacy_scan` en de regel is dan allang iets anders.
 * Het spoor mag dat einde NIET laten vallen; dan zou de duur van een echte
 * stap verdwijnen.
 */

const ID = 'assistant-1';

function harness(initial = {}) {
    let messages = [{ id: ID, role: 'assistant', content: '', ...initial }];
    const ctx = { setMessages: (fn) => { messages = fn(messages); } };
    const ids = { assistantMsgId: ID, activeIdRef: { current: ID }, contentRef: { current: '' }, flusher: {}, workRef: {} };
    return {
        phase: (data) => dispatchSSEEvent(ctx, 'phase', data, ids),
        get msg() { return messages[0]; },
    };
}

const start = (stage, detail) => ({ stage, status: 'start', detail });
const end = (stage, durationMs) => ({ stage, status: 'end', durationMs });

describe('het spoor loopt mee met de live regel', () => {
    it('legt elke fase vast, ook nadat de live regel gewist is', () => {
        const h = harness();
        h.phase(start('processed_history'));
        h.phase(end('processed_history', 20));
        h.phase(start('building_prompt'));
        h.phase(end('building_prompt', 40));
        h.phase(start('streaming_start', 'claude-opus-5'));

        expect(h.msg.currentPhase).toBeNull(); // streaming_start wist de regel
        expect(h.msg.phaseTrail.map(r => [r.stage, r.durationMs])).toEqual([
            ['processed_history', 20],
            ['building_prompt', 40],
            ['streaming_start', null],
        ]);
        expect(h.msg.phaseTrail[2].detail).toBe('claude-opus-5');
    });

    it('BIJT — een end die de LIVE REGEL laat vallen, landt wél in het spoor', () => {
        // guardrails loopt om privacy_scan heen. Op het moment dat guardrails
        // afsluit is currentPhase allang null; de live regel negeert dat einde
        // terecht. Wie het spoor aan diezelfde `if` hangt, verliest de duur van
        // guardrails.
        const h = harness();
        h.phase(start('guardrails'));
        h.phase(start('privacy_scan'));
        h.phase(end('privacy_scan', 40));
        h.phase(end('guardrails', 60));

        expect(h.msg.phaseTrail.map(r => [r.stage, r.durationMs])).toEqual([
            ['guardrails', 60],
            ['privacy_scan', 40],
        ]);
    });

    it('BIJT — de zes vensters van één privacyscan blijven één stap', () => {
        const h = harness();
        h.phase(start('privacy_scan_large', '1/6'));
        h.phase(start('privacy_scan_large', '2/6'));
        h.phase(start('privacy_scan_large', '3/6'));
        h.phase(end('privacy_scan_large', 900));

        expect(h.msg.phaseTrail).toHaveLength(1);
        expect(h.msg.phaseTrail[0]).toMatchObject({ stage: 'privacy_scan_large', detail: '3/6', durationMs: 900 });
    });

    it('laat de live regel precies zoals hij was', () => {
        const h = harness();
        h.phase(start('kb_search'));
        expect(h.msg.currentPhase).toMatchObject({ stage: 'kb_search', detail: null });
        h.phase(end('kb_search', 200));
        expect(h.msg.currentPhase).toBeNull();
    });

    it('raakt geen ander bericht aan', () => {
        let messages = [{ id: 'other', role: 'assistant' }, { id: ID, role: 'assistant' }];
        const ctx = { setMessages: (fn) => { messages = fn(messages); } };
        const ids = { assistantMsgId: ID, activeIdRef: { current: ID }, contentRef: { current: '' }, flusher: {}, workRef: {} };
        dispatchSSEEvent(ctx, 'phase', start('kb_search'), ids);
        expect(messages[0].phaseTrail).toBeUndefined();
        expect(messages[1].phaseTrail).toHaveLength(1);
    });
});
