/**
 * Run output is UNTRUSTED text, and the shared Markdown renderer is not built
 * for untrusted text.
 *
 * A cowork run is the one place in the product where a model writes prose with
 * nobody watching, after reading whatever it was pointed at — mail, web pages,
 * documents. Whatever a page it read talked it into saying lands here. The
 * shared MarkdownRenderer maps a handful of fence languages onto *active*
 * components rather than onto text: ```map-embed``` becomes a live <iframe>
 * whose src comes straight out of the block. That is a prompt-injection path
 * from a mail footer to an embed in the owner's browser — no origin
 * allow-list, no sandbox. (Not script execution: react-markdown 10 drops raw
 * HTML and javascript: URLs. It is an embed and tracking path.)
 *
 * So before run output reaches that renderer, every fence whose language is
 * not on the inert allow-list below is rewritten to a plain one. The block's
 * text is kept — deleting model output silently would be its own bug — it
 * simply renders as code instead of as a component.
 *
 * ALLOW-LIST, not deny-list, and deliberately so. Listing today's four
 * dangerous languages would mean the fifth renderer someone adds to
 * MarkdownRenderer next year is live in cowork the day it lands, with nothing
 * here to notice. Listing the inert ones instead makes the default "render it
 * as text", which is the answer that stays correct.
 */
import React from 'react';


/**
 * Fence languages that the shared renderer treats as ordinary highlighted
 * code. Anything outside this set — including a language nobody has invented
 * yet — is rendered as plain text instead.
 */
export const INERT_FENCE_LANGUAGES = new Set([
    // plain / prose
    'plaintext', 'text', 'txt', 'plain', 'markdown', 'md', 'log', 'diff', 'patch',
    // data & config
    'json', 'json5', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'csv', 'tsv',
    'xml', 'html', 'css', 'scss', 'sass', 'less', 'graphql', 'http', 'regex', 'env',
    // shells
    'bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'powershell', 'ps', 'ps1', 'bat', 'cmd',
    // programming languages
    'javascript', 'js', 'jsx', 'typescript', 'ts', 'tsx', 'python', 'py', 'sql',
    'java', 'c', 'h', 'cpp', 'c++', 'cs', 'csharp', 'go', 'golang', 'rust', 'rs',
    'ruby', 'rb', 'php', 'swift', 'kotlin', 'scala', 'dart', 'elixir', 'erlang',
    'haskell', 'clojure', 'lua', 'perl', 'r', 'matlab', 'objectivec', 'groovy', 'vb',
    // build & ops
    'dockerfile', 'docker', 'makefile', 'make', 'cmake', 'nginx', 'apache',
    'terraform', 'hcl', 'properties', 'gradle', 'protobuf', 'proto',
]);

/**
 * The language an unsafe fence is rewritten to. Not `text`/`md`/an empty info
 * string: the renderer strips exactly those when they wrap the whole message,
 * which would spill the block's body back into the document as Markdown.
 */
const NEUTRAL_LANGUAGE = 'plaintext';

/**
 * Opening or closing fence.
 *
 * The prefix is not just indentation. CommonMark parses a fence inside a
 * block quote — `> ```map-embed` — as a fenced block with an info string
 * exactly like an unquoted one, and react-markdown does too. A rule that only
 * allowed three spaces of indent therefore let the whole allow-list be walked
 * around by prefixing two characters, which is precisely the shape a mail
 * footer takes when it quotes something at you. Quote markers (nested ones
 * included) and list-item markers are part of the prefix here, and are put
 * back untouched when the line is rewritten.
 *
 * Matching more lines than CommonMark would is the safe direction: the worst
 * case is a fence rendered as plain text.
 */
const FENCE_LINE = /^((?:[ \t]{0,3}(?:>|[-*+]|\d{1,9}[.)])[ \t]?)*[ \t]{0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Rewrite every fenced block whose language is not inert into a plain one.
 * Content outside fences, and the text inside them, is left exactly as it was.
 *
 * @param {unknown} markdown raw run output
 * @returns {unknown} the same value for non-strings, so callers can pass
 *   whatever the API handed them
 */
export function neutraliseActiveFences(markdown) {
    if (typeof markdown !== 'string' || markdown === '') return markdown;

    const lines = markdown.split('\n');
    let open = null; // { char, length } of the fence currently being closed

    for (let i = 0; i < lines.length; i += 1) {
        const match = FENCE_LINE.exec(lines[i]);
        if (!match) continue;

        const [, indent, marker, rest] = match;
        const char = marker[0];

        if (open) {
            // Only a fence of the same character and at least the same length
            // closes; anything else is body text of the open block.
            if (char === open.char && marker.length >= open.length && rest.trim() === '') {
                open = null;
            }
            continue;
        }

        // A backtick info string may not itself contain a backtick — such a
        // line opens nothing, so it must not put us in "inside a fence" state.
        if (char === '`' && rest.includes('`')) continue;

        open = { char, length: marker.length };

        const info = rest.trim();
        if (info === '') continue;

        const language = info.split(/\s+/)[0].toLowerCase();
        if (INERT_FENCE_LANGUAGES.has(language)) continue;

        lines[i] = `${indent}${marker}${NEUTRAL_LANGUAGE}`;
    }

    return lines.join('\n');
}

/**
 * The other way run output reaches out of the page: `![](https://…)`.
 *
 * Neutralising fences closes the embed path but not this one. A Markdown
 * image is a fetch the browser makes on its own, the moment the row is
 * opened, to a host the run's output chose — which hands that host the
 * owner's IP, user-agent and referrer without anyone clicking anything. It is
 * the same tracking beacon as the iframe, written with two fewer characters.
 *
 * So no <img> is rendered for run output at all. The image is not swallowed:
 * its alt text and its address are shown as TEXT, which is the difference
 * between "a URL the browser fetches" and "a URL the reader can look at".
 *
 * Ordinary links are deliberately left alone. `<a target="_blank" rel="…">`
 * fetches nothing until the owner decides to click it, which is a different
 * risk class from a beacon that fires on open.
 *
 * @param {(key: string, fallback: string, params?: object) => string} t
 * @returns {object} a `components` map for MarkdownRenderer (spread last there,
 *   so these entries win)
 */
export function inertMarkdownComponents(t) {
    return {
        img: ({ src, alt }) => {
            const address = typeof src === 'string' ? src : '';
            const described = typeof alt === 'string' && alt.trim() ? alt.trim() : '';
            return React.createElement(
                'span',
                {
                    'data-testid': 'cowork-inert-image',
                    className: 'inline-block px-1.5 py-0.5 rounded border text-[11.5px] break-all',
                    style: { borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' },
                },
                [
                    t('cowork.history.image_not_loaded', 'Image not loaded'),
                    described && `: ${described}`,
                    address && ` (${address})`,
                ].filter(Boolean).join(''),
            );
        },
    };
}
