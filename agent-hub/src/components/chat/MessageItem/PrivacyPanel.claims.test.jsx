import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';

import PrivacyPanel from './PrivacyPanel';

/**
 * C7 — het paneel is de DIEPERE vorm van dezelfde claim als de regel onder het
 * bericht, en moet dus dezelfde bewijslast dragen.
 *
 * De slotzin luidde onvoorwaardelijk "The AI only saw placeholders like
 * [email_1]". Die `[email_1]` is een verzinsel: hij komt uit de Engelse tekst,
 * niet uit dit gesprek. In een beurt waarin een telefoonnummer werd vervangen
 * staat er dus een plaatsvervanger op het scherm die nooit heeft bestaan — en
 * precies zo'n voorbeeld is wat een gebruiker onthoudt en navertelt.
 *
 * De regel: een plaatsvervanger mag alleen genoemd worden als hij gemeten is
 * (privacyLine.js — de echte waarde staat woordelijk in het bericht van deze
 * beurt). Kan dat niet, dan noemt de zin er geen enkele. Dat is geen mindere
 * zin maar een eerlijke.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = (_key, en, params) => {
    if (!params) return en;
    return Object.entries(params).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), en);
};

/** Een beurt: het getypte bericht, en het antwoord dat de tokenisatie draagt. */
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
        // Er passen er hooguit drie op een regel. Bij vijf vervangingen leest
        // "The AI only saw placeholders — [a_1], [b_1], [c_1]." als de
        // volledige opsomming, terwijl er twee ontbreken. Dit paneel heet in
        // zijn eigen koptekst de DIEPERE vorm van dezelfde claim; het mag niet
        // meer volledigheid beloven dan de ondiepe vorm eronder.
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
        // De zin verdwijnt niet — hij zegt alleen minder.
        expect(explainer).toMatch(/placeholders/i);
    });

    it('noemt de plaatsvervanger die er echt voor in de plaats ging', () => {
        renderPanel({ ...BASE, tokenMap: { '[email_1]': 'j.devries@vandijk.nl' } });
        const explainer = screen.getByTestId('privacy-panel-explainer').textContent;
        expect(explainer).toContain('[email_1]');
    });

    it('noemt niets uit een map die over een ANDER bericht gaat', () => {
        // De kluis draagt tokens van eerdere beurten mee. Een token waarvan de
        // echte waarde niet in dit bericht staat, bewijst niets over dit
        // bericht — en dan is de naam van die plaatsvervanger een gok.
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
        const src = fs.readFileSync(path.join(HERE, 'PrivacyPanel.jsx'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        expect(src).not.toMatch(/rgba?\(/);
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});
