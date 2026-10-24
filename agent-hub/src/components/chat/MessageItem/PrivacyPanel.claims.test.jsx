import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';

import PrivacyPanel from './PrivacyPanel';

/**
 * C7: the panel is the DEEPER form of the same claim as the line under the message, and must therefore carry the
 * same burden of proof.
 *
 * The closing sentence read unconditionally "The AI only saw placeholders like [email_1]". That `[email_1]` is an
 * invention: it comes from the English text, not from this conversation. In a turn in which a phone number was
 * replaced, the screen thus shows a placeholder that never existed, and exactly such an example is what a user
 * remembers and retells.
 *
 * The rule: a placeholder may only be named if it has been measured (privacyLine.js: the real value stands verbatim
 * in the message of this turn). If that cannot be done, the sentence names none at all. That is not a weaker
 * sentence but an honest one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = (_key, en, params) => {
    if (!params) return en;
    return Object.entries(params).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), en);
};

/** One turn: the typed message, and the answer that carries the tokenisation. */
function turn(info, userText = 'Mail Jan de Vries op j.devries@vandijk.nl') {
    return [
        { role: 'user', content: userText },
        { role: 'assistant', content: 'Doe ik.', tokenisationInfo: info },
    ];
}

function renderPanel(info, userText) {
    const messages = turn(info, userText);
    return render(<PrivacyPanel msg={messages[1]} idx={1} allMessages={messages} t={T} />);
}

const BASE = { count: 1, categories: ['Email'], action: 'tokenise', source: 'dlp', automatic: true };

describe('PrivacyPanel — een opsomming die de hele lijst lijkt', () => {
    it('zegt hoeveel het er waren zodra het er meer zijn dan het toont', () => {
        // Only up to three fit on a line. With five replacements, "The AI only saw placeholders — [a_1], [b_1], [c_1]."
        // reads as the complete enumeration, while two are missing. This panel is called, in its own heading, the DEEPER
        // form of the same claim. It may not promise more completeness than the shallow form beneath it.
        const text = 'aaaa bbbb cccc dddd eeee';
        renderPanel({
            count: 5,
            action: 'tokenize',
            tokenMap: {
                '[a_1]': 'aaaa', '[b_1]': 'bbbb', '[c_1]': 'cccc',
                '[d_1]': 'dddd', '[e_1]': 'eeee',
            },
        }, text);

        const explainer = screen.getByTestId('privacy-panel-explainer');
        expect(explainer.textContent).toMatch(/5 values were replaced in all/i);
        expect(explainer.textContent).toMatch(/\[a_1\]/);
    });

    it('somt zonder voorbehoud op waar de opsomming wél compleet is', () => {
        renderPanel({
            count: 1,
            action: 'tokenize',
            tokenMap: { '[email_1]': 'j.devries@vandijk.nl' },
        });

        const explainer = screen.getByTestId('privacy-panel-explainer');
        expect(explainer.textContent).toMatch(/only saw placeholders — \[email_1\]/i);
        expect(explainer.textContent).not.toMatch(/in all/i);
    });
});

describe('PrivacyPanel — geen verzonnen plaatsvervanger (C7)', () => {
    beforeEach(cleanup);

    it('noemt geen enkele plaatsvervanger als de tokenmap er niet is', () => {
        renderPanel({ ...BASE });
        const explainer = screen.getByTestId('privacy-panel-explainer').textContent;
        expect(explainer).not.toContain('[email_1]');
        expect(explainer).not.toMatch(/\[[^\]]+\]/);
        // The sentence does not disappear. It merely says less.
        expect(explainer).toMatch(/placeholders/i);
    });

    it('noemt de plaatsvervanger die er echt voor in de plaats ging', () => {
        renderPanel({ ...BASE, tokenMap: { '[email_1]': 'j.devries@vandijk.nl' } });
        const explainer = screen.getByTestId('privacy-panel-explainer').textContent;
        expect(explainer).toContain('[email_1]');
    });

    it('noemt niets uit een map die over een ANDER bericht gaat', () => {
        // The vault carries tokens from earlier turns along. A token whose real
        // value is not in this message proves nothing about this message, and then the name of that stand-in is a guess.
        renderPanel(
            { ...BASE, tokenMap: { '[phone_7]': '06-12345678' } },
            'Mail Jan de Vries op j.devries@vandijk.nl',
        );
        const explainer = screen.getByTestId('privacy-panel-explainer').textContent;
        expect(explainer).not.toContain('[phone_7]');
        expect(explainer).not.toMatch(/\[[^\]]+\]/);
    });

    it('belooft geen volledige dekking als een bijlage half gescand is', () => {
        renderPanel({
            ...BASE,
            tokenMap: { '[email_1]': 'j.devries@vandijk.nl' },
            attachments: [{ filename: 'groot.pdf', reason: 'overflow', scannedPages: 3, totalPages: 40 }],
        });
        expect(screen.queryByTestId('privacy-panel-explainer')).toBeNull();
        expect(document.body.textContent).toMatch(/could not be checked/i);
    });

    it('schildert geen enkele kleur buiten de thematokens om', () => {
        const src = fs.readFileSync(path.join(HERE, 'PrivacyPanel.tsx'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        expect(src).not.toMatch(/rgba?\(/);
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});
