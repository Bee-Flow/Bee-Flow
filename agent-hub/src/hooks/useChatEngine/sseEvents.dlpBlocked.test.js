import { describe, it, expect } from 'vitest';

import { dispatchSSEEvent } from './sseEvents';
import { interpolate } from '../useTranslation';
import EN_DEFAULTS from '../../i18n/en-defaults';

/**
 * Het `dlp_blocked`-event: de tekst die een gebruiker leest als een bijlage om
 * privacyredenen wordt tegengehouden.
 *
 * Waarom deze test bestaat: de woordenboekwaarde WINT van de Engelse fallback
 * in de code (useTranslation.jsx:270-272), en `interpolate(value, undefined)`
 * geeft de waarde ongewijzigd terug (308-309). Een `t(sleutel, '…${file}…')`
 * zonder derde argument levert daardoor letterlijk `{filename}` op het scherm
 * op. Deze test bijt op precies dat: de bestandsnaam MOET in de zin staan en
 * `{filename}` mag er nooit meer in staan.
 */

const ID = 'assistant-1';

/**
 * Een `t` die het echte gedrag nabootst: woordenboekwaarde eerst, Engelse
 * string-fallback tweede, daarna interpoleren. Onthoudt welke sleutels zijn
 * opgevraagd, zodat een test kan bewijzen dat de grammatica om de SLEUTEL
 * draait en niet om een string in de code.
 */
function makeT() {
    const keys = [];
    const t = (key, fallbackOrParams, paramsArg) => {
        keys.push(key);
        const hasStringFallback = typeof fallbackOrParams === 'string';
        const params = hasStringFallback ? paramsArg : fallbackOrParams;
        let value = EN_DEFAULTS[key];
        if (typeof value !== 'string') value = hasStringFallback ? fallbackOrParams : key;
        return interpolate(value, params);
    };
    t.keys = keys;
    return t;
}

/** Een minimale dispatch-omgeving: alleen wat dit event aanraakt. */
function harness() {
    let messages = [{ id: ID, role: 'assistant', content: '' }];
    const t = makeT();
    // `tRef` hangt aan de engine-context, niet aan de per-stream ids.
    const ctx = { setMessages: (fn) => { messages = fn(messages); }, tRef: { current: t } };
    const ids = {
        assistantMsgId: ID,
        activeIdRef: { current: ID },
        contentRef: { current: '' },
        flusher: { cancel: () => {} },
        workRef: { current: null },
    };
    return {
        send: (data) => dispatchSSEEvent(ctx, 'dlp_blocked', data, ids),
        get msg() { return messages[0]; },
        get keys() { return t.keys; },
    };
}

describe('dlp_blocked — de blokkadetekst', () => {
    it('BIJT — overflow toont de bestandsnaam, nooit de letterlijke {filename}', () => {
        const h = harness();
        h.send({ reason: 'attachment_overflow', filename: 'jaarrekening.pdf' });
        expect(h.msg.content).toContain('jaarrekening.pdf');
        expect(h.msg.content).not.toContain('{filename}');
        expect(h.msg.isError).toBe(true);
        expect(h.msg.isStreaming).toBe(false);
    });

    it('BIJT — timeout en degraded interpoleren de bestandsnaam ook', () => {
        for (const reason of ['attachment_timeout', 'attachment_degraded']) {
            const h = harness();
            h.send({ reason, filename: 'contract.docx' });
            expect(h.msg.content).toContain('contract.docx');
            expect(h.msg.content).not.toContain('{filename}');
        }
    });

    it('BIJT — pii kiest een ANDERE sleutel met en zonder bestandsnaam', () => {
        const withFile = harness();
        withFile.send({ reason: 'attachment_pii', categories: ['name', 'iban'], filename: 'cv.pdf' });
        const withoutFile = harness();
        withoutFile.send({ reason: 'attachment_pii', categories: ['name', 'iban'] });

        const keyWith = withFile.keys.find(k => k.startsWith('dlp.blocked_attachment_pii'));
        const keyWithout = withoutFile.keys.find(k => k.startsWith('dlp.blocked_attachment_pii'));
        expect(keyWith).toBeTruthy();
        expect(keyWithout).toBeTruthy();
        expect(keyWith).not.toBe(keyWithout);

        expect(withFile.msg.content).toContain('cv.pdf');
        expect(withFile.msg.content).toContain('name, iban');
        expect(withFile.msg.content).not.toContain('{filename}');
        expect(withFile.msg.content).not.toContain('{categories}');
        // Zonder bestandsnaam blijft er geen kaal aanhalingsteken of losse
        // placeholder achter.
        expect(withoutFile.msg.content).toContain('name, iban');
        expect(withoutFile.msg.content).not.toContain('{filename}');
        expect(withoutFile.msg.content).not.toContain('“');
    });

    it('BIJT — een pii-event zonder categorieën gaat door een sleutel, niet door een Engelse string in de code', () => {
        const h = harness();
        h.send({ reason: 'attachment_pii' });
        expect(h.keys).toContain('dlp.categories_unknown');
        expect(h.msg.content).toContain('PII');
    });

    it('BIJT — zonder bestandsnaam leest de gebruiker "the attachment", niet de kale sleutel', () => {
        for (const reason of ['attachment_overflow', 'attachment_timeout', 'attachment_degraded',
            'attachment_user_blocked', 'attachment_ask_timeout']) {
            const h = harness();
            h.send({ reason });
            expect(h.keys).toContain('dlp.the_attachment');
            expect(h.msg.content).toContain('the attachment');
            expect(h.msg.content).not.toContain('{filename}');
            expect(h.msg.content).not.toContain('dlp.');
        }
    });

    it('BIJT — user_blocked en ask_timeout dragen de bestandsnaam via params', () => {
        const blocked = harness();
        blocked.send({ reason: 'attachment_user_blocked', filename: 'paspoort.jpg' });
        expect(blocked.keys).toContain('dlp.blocked_attachment_user');
        expect(blocked.msg.content).toContain('paspoort.jpg');
        expect(blocked.msg.content).not.toContain('{filename}');

        const asked = harness();
        asked.send({ reason: 'attachment_ask_timeout', filename: 'paspoort.jpg' });
        expect(asked.keys).toContain('dlp.blocked_attachment_ask_timeout');
        expect(asked.msg.content).toContain('paspoort.jpg');
        expect(asked.msg.content).not.toContain('{filename}');
    });

    it('laat de takken zonder placeholder met rust', () => {
        const tooLarge = harness();
        tooLarge.send({ reason: 'pii_unavailable', kind: 'too_large' });
        expect(tooLarge.keys).toContain('dlp.blocked_pii_too_large');
        expect(tooLarge.msg.content).toBe(EN_DEFAULTS['dlp.blocked_pii_too_large']);

        const unavailable = harness();
        unavailable.send({ reason: 'pii_unavailable' });
        expect(unavailable.keys).toContain('dlp.blocked_pii_unavailable');

        const policy = harness();
        policy.send({ reason: 'policy' });
        expect(policy.keys).toContain('dlp.blocked_policy');
    });
});
