/**
 * C12 — het chatscherm praat Nederlands zodra het woordenboek dat doet.
 *
 * Twee soorten test, want de bevinding heeft twee helften.
 *
 * ── 1. DE SCAN ──────────────────────────────────────────────────────────────
 * De retrofit is klaar op het moment dat er in `components/chat/**` geen
 * gebruikerstekst meer LOS in de bron staat. Dat is mechanisch te controleren
 * en dus staat het hier als test, in dezelfde geest als
 * `src/i18n/i18nGuard.test.js`: de guard daar controleert of een SLEUTEL
 * bestaat, deze controleert of er überhaupt een sleutel is.
 *
 * De regel is een toelatingslijst, geen patroon. Een patroon dat "leest dit als
 * Engels?" probeert te beantwoorden heeft twee uitwegen die allebei fout zijn —
 * de zin herschrijven tot het patroon hem niet meer ziet, of het patroon
 * verbreden tot het niets meer vangt. Een naam die niet vertaalt (Gmail, Google
 * Drive, ElevenLabs) staat daarom met zoveel woorden op BRAND_LITERALS, en al
 * het andere moet door t(). De lijst heeft zelf een rotcontrole: een merknaam
 * die nergens meer voorkomt moet eraf, anders vrijwaart hij stilletjes wat er
 * later op die plek komt te staan.
 *
 * ── 2. HET GEDRAG ───────────────────────────────────────────────────────────
 * Een scan bewijst alleen dat er een t() STAAT. Of de tekst die je op het
 * scherm ziet er ook daadwerkelijk doorheen komt, bewijst alleen een render.
 * Daarom hieronder een handvol componenten met een t() die elke sleutel als
 * «sleutel» teruggeeft: wat er dan nog Engels op het scherm staat, stond er
 * buiten t() om.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// De scan
// ---------------------------------------------------------------------------

/**
 * Namen die niet vertalen. Merk- en productnamen van derden: ze staan in élke
 * taal zo op het scherm, en een vertaler die ze te zien krijgt kan alleen maar
 * schade aanrichten. Elke regel moet vandaag nog ergens voorkomen — zie de
 * rotcontrole onderaan.
 */
const BRAND_LITERALS = new Set(['Gmail', 'Google Drive', 'ElevenLabs', 'Nano Banana', 'BPM']);

/** Attributen waarvan de waarde als tekst op het scherm of in een schermlezer belandt. */
const TEXT_ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'label', 'tooltip', 'aria-description'];

/**
 * Twee echte woorden achter elkaar: dat is een zin. Eén woord of een reeks
 * symbolen draagt geen grammatica en levert een vertaler niets op. Een zin die
 * met een CIJFER begint telt gewoon mee — "3 items redacted before sending" is
 * precies de vorm die deze batch wegnam, en die mag niet via de voordeur
 * terugkomen omdat het patroon op een letter begon te matchen.
 */
const isSentence = (text) => /[A-Za-z]{2,} +[A-Za-z]{2,}/.test(text);

/** Waarde van een attribuut of tekstknoop die sowieso buiten schot blijft. */
const exempt = (value) => !value || value.includes('${') || BRAND_LITERALS.has(value);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(p);
        else if (/\.jsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) yield p;
    }
}

/** Commentaar eruit — daar staat het meeste Engels, en niets ervan rendert. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

const chatSources = [...walk(HERE)].map(file => ({
    rel: path.relative(HERE, file).replace(/\\/g, '/'),
    src: stripComments(fs.readFileSync(file, 'utf8')),
}));

describe('C12 — geen losse gebruikerstekst meer in het chatscherm', () => {
    it('elk zichtbaar attribuut krijgt zijn waarde van t(), op merknamen na', () => {
        // Twee vormen, want een attribuut kan zijn tekst ook in een EXPRESSIE
        // dragen: `title="Stop"` en `title={'Stop'}` zetten hetzelfde woord op
        // het scherm, en een scan die alleen de eerste kent geeft de tweede
        // een vrije doorgang. Hetzelfde geldt voor de backtick-vorm.
        const PLAIN = new RegExp(`\\b(${TEXT_ATTRS.join('|')})="([^"]*)"`, 'g');
        const EXPR = new RegExp(`\\b(${TEXT_ATTRS.join('|')})=\\{\\s*(['"\`])([^'"\`]*)\\2\\s*\\}`, 'g');
        const loose = [];
        for (const { rel, src } of chatSources) {
            for (const m of src.matchAll(PLAIN)) {
                const value = m[2].trim();
                // Leeg is bewust: een decoratieve <img alt=""> hoort leeg te zijn.
                // Een `${…}` is al een uitdrukking; die is elders vertaald.
                if (exempt(value)) continue;
                loose.push(`${rel}: ${m[1]}="${value}"`);
            }
            for (const m of src.matchAll(EXPR)) {
                const value = m[3].trim();
                if (exempt(value)) continue;
                loose.push(`${rel}: ${m[1]}={'${value}'}`);
            }
        }
        expect(
            loose,
            'deze attributen dragen tekst die geen enkele vertaling kan bereiken — '
            + `haal ze door t('sleutel', 'English'), of zet een merknaam op BRAND_LITERALS:\n${loose.join('\n')}`,
        ).toEqual([]);
    });

    it('geen kale Engelse zin als tekst tussen twee JSX-tags', () => {
        // Een tekstknoop met een spatie erin is een ZIN, geen symbool: "Send
        // message", "Awaiting Approval", "Drop files here". Losse woorden en
        // leestekens (·, →, ✓, een emoji) blijven buiten schot — die dragen
        // geen taal en een sleutel eromheen levert een vertaler niets op.
        // Eén regel, en tussen de tags alleen tekens die in proza voorkomen.
        // Dat laatste is wat de scan uit de CODE houdt: een `>` in
        // `steps.filter(s => s.status === 'done')` is een groter-dan, en een
        // patroon dat leestekens toelaat leest de halve module als zin.
        //
        // Twee dingen die een eerdere versie hiervan doorliet, allebei de
        // NORMALE opmaakvorm en dus geen randgeval: een zin die na het
        // formatteren over meer dan één regel staat, en een zin die met een
        // cijfer begint. En de derde vorm: dezelfde zin als STRING-EXPRESSIE
        // tussen de tags, `<span>{'Nothing here is translated'}</span>`.
        const RX = />[ \t]*\n?[ \t]*([A-Za-z0-9][A-Za-z0-9 ,'’&+/·—–\-\n\t]*[A-Za-z.!?])[ \t]*\n?[ \t]*</g;
        const EXPR = />[^<>]*\{\s*(['"])([^'"]+)\1\s*\}/g;
        const loose = [];
        for (const { rel, src } of chatSources) {
            for (const m of src.matchAll(RX)) {
                const text = m[1].replace(/\s+/g, ' ').trim();
                if (exempt(text) || !isSentence(text)) continue;
                loose.push(`${rel}: >${text}<`);
            }
            for (const m of src.matchAll(EXPR)) {
                const text = m[2].trim();
                if (exempt(text) || !isSentence(text)) continue;
                loose.push(`${rel}: {'${text}'}`);
            }
        }
        expect(
            loose,
            `deze zinnen staan los in de JSX en blijven dus voorgoed Engels:\n${loose.join('\n')}`,
        ).toEqual([]);
    });

    it('de merknamenlijst rot niet: elke naam komt nog ergens voor', () => {
        const dead = [...BRAND_LITERALS].filter(
            name => !chatSources.some(({ src }) => src.includes(name)),
        );
        expect(
            dead,
            'deze namen staan nergens meer in components/chat/** — haal ze van '
            + `BRAND_LITERALS af, anders vrijwaren ze wat er later op die plek komt:\n${dead.join('\n')}`,
        ).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Het gedrag
// ---------------------------------------------------------------------------

// Eén t() voor alle componenten hieronder: hij geeft «sleutel» terug in plaats
// van de Engelse reservetekst. Wat er na een render nog aan Engels op het
// scherm staat, is dus tekst die t() nooit heeft gezien.
const MARK = (key) => `«${key}»`;
vi.mock('../../hooks/useTranslation', () => ({
    __esModule: true,
    default: () => ({ t: (key) => MARK(key), locale: 'nl', setLocale: () => {}, isLoading: false, strings: {} }),
    interpolate: (v) => v,
}));

import ComposerToolsMenu from './ComposerToolsMenu';
import BrowserLivePreview from './MessageItem/BrowserLivePreview';
import DraftCardShell from './MessageItem/DraftCardShell';
import KbSourcesPanel from './MessageItem/KbSourcesPanel';

describe('C12 — de tekst komt echt uit t()', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('de "+"-knop van de composer noemt zichzelf via een sleutel', () => {
        render(<ComposerToolsMenu items={[{ id: 'x', label: 'X', kind: 'action' }]} />);
        const button = screen.getByTestId('composer-tools-button');
        expect(button.getAttribute('aria-label')).toBe(MARK('chat.composer.tools_menu'));
        expect(button.getAttribute('title')).toBe(MARK('chat.composer.tools_menu'));
    });

    it('de conceptkaart haalt zijn statuswoorden en knoppen uit sleutels', () => {
        const { container } = render(
            <DraftCardShell status="pending" colors={{ border: '', bg: '', text: '', btn: '' }}
                icon={() => null} actionLabel="New Event" titleIcon={() => null} title="Standup"
                onConfirm={() => {}} onDiscard={() => {}} />,
        );
        const text = container.textContent;
        expect(text).toContain(MARK('chat.draft.awaiting_approval'));
        expect(text).toContain(MARK('chat.draft.confirm'));
        expect(text).toContain(MARK('chat.draft.discard'));
        expect(text).not.toContain('Awaiting Approval');
        expect(text).not.toContain('Discard');
    });

    it('de bronnenlijst telt via sleutels in plaats van via een Engelse -s', () => {
        const msg = {
            kbSources: [
                { title: 'Handboek', section: 'Intro', score: 0.9, content: 'a', page: 3 },
                { title: 'Handboek', score: 0.5, content: 'b' },
            ],
        };
        const { container } = render(<KbSourcesPanel msg={msg} />);
        const text = container.textContent;
        expect(text).toContain(MARK('chat.msg.kb_chunks_from_docs_plural'));
        expect(text).toContain(MARK('chat.msg.kb_chunks_plural'));
        // "Chunk 2" was de laatste plek waar een positienummer een Engels
        // woord aan zich vast had zitten.
        expect(text).toContain(MARK('chat.msg.kb_chunk_n'));
        expect(text).not.toMatch(/\bSources? from\b/);
        expect(text).not.toMatch(/\bchunks?\b/);
    });

    it('de browservoorbeeldkaart zegt via sleutels wat hij aan het doen is', () => {
        const { container } = render(<BrowserLivePreview preview={{ queued: true, queuePosition: 2 }} />);
        const text = container.textContent;
        expect(text).toContain(MARK('chat.msg.browse_queued_pos'));
        expect(text).not.toContain('Waiting for an available browser session');
    });
});
