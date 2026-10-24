/**
 * C12: the chat screen speaks Dutch as soon as the dictionary does that.
 *
 * Two kinds of test, because the finding has two halves.
 *
 * ── 1. THE SCAN ─────────────────────────────────────────────────────────────
 * The retrofit is done at the moment that there is no user text LOOSE in the
 * source in `components/chat/**` any more. That is mechanically checkable, so it
 * sits here as a test, in the same spirit as `src/i18n/i18nGuard.test.js`. That
 * guard checks whether a KEY exists, and this one checks whether there is a key at
 * all.
 *
 * The rule is an allow-list, not a pattern. A pattern that tries to answer "does
 * this read as English?" has two ways out, and both are wrong: rewriting the
 * sentence until the pattern no longer sees it, or broadening the pattern until it
 * catches nothing. A name that does not translate (Gmail, Google Drive,
 * ElevenLabs) is therefore listed by name on BRAND_LITERALS, and everything else
 * must go through t(). The list has its own rot check: a brand name that appears
 * nowhere any more must be removed, otherwise it silently excuses whatever later
 * stands in that place.
 *
 * ── 2. THE BEHAVIOUR ────────────────────────────────────────────────────────
 * A scan only proves that a t() IS there. Whether the text you see on the screen
 * actually comes through it, only a render proves. Therefore, below, a handful of
 * components with a t() that returns every key as «key»: whatever English is then
 * still on the screen was outside t().
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
 * Names that do not translate. Brand and product names of third parties: they
 * appear on screen in that form in every language, and a translator who gets to
 * see them can only do harm. Each line must appear somewhere today. See the rot
 * check at the bottom.
 */
const BRAND_LITERALS = new Set(['Gmail', 'Google Drive', 'ElevenLabs', 'Nano Banana', 'BPM']);

/** Attributes whose value lands as text on the screen or in a screen reader. */
const TEXT_ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'label', 'tooltip', 'aria-description'];

/**
 * Two real words in a row: that is a sentence. One word, or a run of symbols,
 * carries no grammar and gives a translator nothing. A sentence that begins with a
 * DIGIT counts too. "3 items redacted before sending" is exactly the form that this
 * batch removed, and it may not come back through the front door just because the
 * pattern began to match on a letter.
 */
const isSentence = (text) => /[A-Za-z]{2,} +[A-Za-z]{2,}/.test(text);

/** Waarde van een attribuut of tekstknoop die sowieso buiten schot blijft. */
const exempt = (value) => !value || value.includes('${') || BRAND_LITERALS.has(value);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(p);
        else if (/\.[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) yield p;
    }
}

/** Comments out. That is where most of the English is, and none of it renders. */
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
        // Two forms, because an attribute can carry its text in an EXPRESSION too:
        // `title="Stop"` and `title={'Stop'}` put the same word on the screen. A scan
        // that knows only the first gives the second a free pass. The same goes for
        // the backtick form.
        const PLAIN = new RegExp(`\\b(${TEXT_ATTRS.join('|')})="([^"]*)"`, 'g');
        const EXPR = new RegExp(`\\b(${TEXT_ATTRS.join('|')})=\\{\\s*(['"\`])([^'"\`]*)\\2\\s*\\}`, 'g');
        const loose = [];
        for (const { rel, src } of chatSources) {
            for (const m of src.matchAll(PLAIN)) {
                const value = m[2].trim();
                // Empty is deliberate: a decorative <img alt=""> should be empty.
                // A `${…}` is already an expression, and that is translated elsewhere.
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
        // A text node with a space in it is a SENTENCE, not a symbol: "Send
        // message", "Awaiting Approval", "Drop files here". Loose words and
        // punctuation (·, →, ✓, an emoji) stay outside the sights, because those
        // carry no language, and a key around them gives a translator nothing.
        // One line, and between the tags only characters that occur in prose.
        // That last part is what the scan keeps out of the CODE. A `>` in
        // `steps.filter(s => s.status === 'done')` is a greater-than, and a pattern
        // that allows punctuation reads half the module as a sentence.
        //
        // Two things that an earlier version of this let through, both in the NORMAL
        // formatting form and therefore no edge case: a sentence that, after
        // formatting, runs over more than one line, and a sentence that begins with a
        // digit. And the third form: the same sentence as a STRING EXPRESSION between
        // the tags, `<span>{'Nothing here is translated'}</span>`.
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

// One t() for all components below: it returns «key» instead of the English
// fallback text. Whatever English is still on the screen after a render is
// therefore text that t() never saw.
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
