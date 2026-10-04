import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import EN_DEFAULTS from '../../i18n/en-defaults';
import {
    SKIP_REASONS,
    STATUS_KEYS,
    STATUS_TOKENS,
    skipGroupOfStep,
    statusLabel,
    tokenFor,
    tokenForSkip,
    tokenForStep,
    type StatusKey,
} from './statusTokens';

/**
 * The status vocabulary, and the two things it used to get wrong.
 *
 * 1. `running` and `paused` carried the identical amber, so on a Cowork row
 *    "working right now" and "deliberately switched off" were one colour, and
 *    the warning colour was spent on the commonest state in the product.
 * 2. every skip was one grey word, so a step that ran and found nothing to do
 *    looked exactly like a step somebody had switched off — and an automation
 *    that quietly wrote nothing for a month reported "Finished".
 *
 * Both are colour/word decisions with no runtime behaviour, which is why they
 * survived so long: nothing failed. These tests are that failure.
 */

// The catalogue is a plain object literal, so TypeScript types it as ~7000
// exact keys rather than an index signature; look ups here are dynamic.
const DICT = EN_DEFAULTS as unknown as Record<string, string>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(HERE, '../../../../server/core/automationRunner');

describe('the table', () => {
    it('gives every status a complete row', () => {
        for (const key of STATUS_KEYS) {
            const token = STATUS_TOKENS[key];
            expect(token, key).toBeTruthy();
            for (const field of ['solid', 'subtle', 'badge', 'labelKey', 'labelEn'] as const) {
                expect(typeof token[field], `${key}.${field}`).toBe('string');
                expect(token[field].length, `${key}.${field}`).toBeGreaterThan(0);
            }
            expect(typeof token.icon, `${key}.icon`).not.toBe('undefined');
            expect(typeof token.spin, `${key}.spin`).toBe('boolean');
        }
    });

    it('names its keys `run_status.<status>` and never studio.status.*', () => {
        // studio.status.* is the OTHER vocabulary (statusOf.js — is this thing
        // live?). Both own a word called "paused" and they do not mean the
        // same thing, so they must never share a dictionary entry.
        for (const key of STATUS_KEYS) {
            expect(STATUS_TOKENS[key].labelKey, key).toBe(`run_status.${key}`);
        }
    });

    it('has every label in the English dictionary, spelled the same', () => {
        // The fallback beside a missing key hides it forever: the screen looks
        // right in English and the key is untranslatable in the Languages
        // panel. i18nGuard.test.js checks the client/server dictionaries agree;
        // this checks the table agrees with them.
        for (const key of STATUS_KEYS) {
            const { labelKey, labelEn } = STATUS_TOKENS[key];
            expect(DICT[labelKey], labelKey).toBe(labelEn);
        }
    });

    it('gives `edited` the pinned colour and a word of its own', () => {
        // The two are one claim apart: `pinned` is data this step really
        // produced and the author froze; `edited` is data the author typed.
        // Downstream they behave identically, which is exactly why the badge
        // must not say the same thing about both (BFSF-408).
        expect(STATUS_TOKENS.edited.solid).toBe(STATUS_TOKENS.pinned.solid);
        expect(STATUS_TOKENS.edited.badge).toBe(STATUS_TOKENS.pinned.badge);
        expect(STATUS_TOKENS.edited.labelKey).not.toBe(STATUS_TOKENS.pinned.labelKey);
        expect(STATUS_TOKENS.edited.labelEn).not.toBe(STATUS_TOKENS.pinned.labelEn);
        expect(STATUS_TOKENS.edited.icon).not.toBe(STATUS_TOKENS.pinned.icon);
    });

    it('hands out keys, never finished English', () => {
        // The regression this stops: a `label` field on the token that call
        // sites render directly. That is how the runs table printed a Dutch
        // sentence with an English status word inside it.
        for (const key of STATUS_KEYS) {
            expect(STATUS_TOKENS[key], key).not.toHaveProperty('label');
        }
    });

    it('paints only in theme tokens — no palette class, no hex', () => {
        // index.css is where the eight themes and the contrast work live. A
        // `text-amber-600 dark:text-amber-400` follows exactly two of them.
        const offenders: string[] = [];
        for (const key of STATUS_KEYS) {
            const token = STATUS_TOKENS[key];
            for (const field of ['solid', 'subtle', 'badge', 'cssVar'] as const) {
                const value = token[field];
                if (value == null) continue; // cssVar, on the neutral rows
                if (/#[0-9a-fA-F]{3,8}\b/.test(value)) offenders.push(`${key}.${field}: hex in "${value}"`);
                if (/\b(?:text|bg|border|ring|from|to|via)-(?:amber|emerald|red|green|blue|cyan|yellow|orange|slate|gray|grey|zinc|neutral|stone|sky|indigo|violet|purple|pink|rose|teal|lime)-\d{2,3}\b/.test(value)) {
                    offenders.push(`${key}.${field}: palette class in "${value}"`);
                }
                for (const m of value.matchAll(/var\((--[a-z0-9-]+)/g)) {
                    // A typo'd token substitutes to nothing and the chip
                    // renders unstyled. index.css.tokenHygiene.test.js checks
                    // the whole tree; this names the file when it is this one.
                    expect(
                        ['--success', '--success-ink', '--warning', '--warning-ink', '--error', '--error-ink',
                            '--type-ai', '--pinned', '--text-tertiary', '--text-secondary', '--bg-secondary'],
                        `${key}.${field} reads ${m[1]}`,
                    ).toContain(m[1]);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('cssVar — the same decision, for a style object', () => {
    it('is the raw token, never the -ink text step', () => {
        // The ink exists so a WORD stays legible against the page; a 1.5px
        // border, a status ring and a minimap swatch are the colour itself.
        for (const key of STATUS_KEYS) {
            const value = STATUS_TOKENS[key].cssVar;
            if (value == null) continue;
            expect(value, key).toMatch(/^var\(--[a-z0-9-]+\)$/);
            expect(value, key).not.toContain('-ink');
        }
    });

    it('names the same token the chips tint from', () => {
        // `subtle` is a color-mix of the raw token, so the two must agree:
        // a card border and the chip in the panel beside it are one status,
        // and two colours for one status is the bug this table prevents.
        for (const key of STATUS_KEYS) {
            const { cssVar, subtle, solid } = STATUS_TOKENS[key];
            if (cssVar == null) {
                // No colour of its own means neutral, and the neutral rows
                // share one recipe — `idle` is as good a witness as any.
                expect(subtle, key).toBe(STATUS_TOKENS.idle.subtle);
                expect(solid, key).toBe(STATUS_TOKENS.idle.solid);
                continue;
            }
            const raw = /var\((--[a-z0-9-]+)\)/.exec(cssVar)?.[1];
            expect(subtle, key).toContain(`var(${raw})`);
        }
    });

    it('leaves exactly the neutral states colourless', () => {
        // Named one by one rather than derived: adding a status and getting
        // null by accident is how a state stops being visible at all.
        const colourless = STATUS_KEYS.filter(k => STATUS_TOKENS[k].cssVar === null);
        expect([...colourless].sort()).toEqual(['cancelled', 'idle', 'paused', 'queued', 'skipped']);
    });

    it('rides along with tokenFor, aliases and unknowns included', () => {
        // How a caller actually reaches it — `tokenFor(status).cssVar`.
        expect(tokenFor('awaiting_confirm').cssVar).toBe('var(--warning)');
        expect(tokenFor('failed').cssVar).toBe('var(--error)');
        expect(tokenFor('weird_future_status').cssVar).toBeNull();
        expect(tokenFor('constructor').cssVar).toBeNull();
    });
});

describe('tokenFor', () => {
    it('resolves the canonical keys', () => {
        for (const key of STATUS_KEYS) {
            expect(tokenFor(key), key).toBe(STATUS_TOKENS[key]);
        }
    });

    it('maps the three server aliases and is case-insensitive', () => {
        expect(tokenFor('failed')).toBe(STATUS_TOKENS.error);
        expect(tokenFor('FAILED')).toBe(STATUS_TOKENS.error);
        expect(tokenFor('awaiting_confirm')).toBe(STATUS_TOKENS.awaiting_approval);
        expect(tokenFor('paused_breakpoint')).toBe(STATUS_TOKENS.paused);
    });

    it('degrades anything else to idle instead of throwing', () => {
        for (const input of [null, undefined, '', 'weird_future_status', 'Success ']) {
            expect(tokenFor(input as string), String(input)).toBe(STATUS_TOKENS.idle);
        }
    });

    it('counts Object.prototype\'s own words among the unknowns', () => {
        // The class the list above misses. `'constructor' in ALIASES` is true
        // of every object literal, so the alias branch was taken for a status
        // that is not an alias and `tokenFor` handed back `undefined` — from
        // the one function whose whole contract is that a caller can pass an
        // unknown server status through it without crashing. The next line is
        // `token.solid`, and that throws.
        for (const input of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'CONSTRUCTOR']) {
            expect(tokenFor(input), input).toBe(STATUS_TOKENS.idle);
            expect(typeof tokenFor(input).solid, input).toBe('string');
        }
    });
});

describe('statusLabel', () => {
    it('asks t() with the key and passes the English as the fallback', () => {
        const seen: Array<[string, string]> = [];
        const t = (key: string, fallback: string) => { seen.push([key, fallback]); return `NL:${key}`; };
        expect(statusLabel(t, STATUS_TOKENS.running)).toBe('NL:run_status.running');
        expect(seen).toEqual([['run_status.running', 'Running']]);
    });

    it('falls back to English when the catalogue has no entry', () => {
        const t = (_key: string, fallback: string) => fallback;
        expect(statusLabel(t, STATUS_TOKENS.nothing_to_do)).toBe('Nothing to do');
    });
});

describe('CW-04 — running is not paused', () => {
    it('gives them different colour, different icon and different words', () => {
        const running = STATUS_TOKENS.running;
        const paused = STATUS_TOKENS.paused;
        expect(running.solid).not.toBe(paused.solid);
        expect(running.subtle).not.toBe(paused.subtle);
        expect(running.badge).not.toBe(paused.badge);
        expect(running.icon).not.toBe(paused.icon);
        expect(running.labelKey).not.toBe(paused.labelKey);
        // The spinner is the other half of the signal: a running row moves.
        expect(running.spin).toBe(true);
        expect(paused.spin).toBe(false);
    });

    it('spends the warning colour on states that want attention, not on work in progress', () => {
        // Amber is finite. While `running` wore it, the colour that should
        // mean "look at this" was on the most ordinary state there is.
        expect(STATUS_TOKENS.running.solid).not.toContain('--warning');
        expect(STATUS_TOKENS.running.badge).not.toContain('--warning');
        expect(STATUS_TOKENS.running.solid).toContain('--type-ai');
    });

    it('hands the canvas the same answer it hands the panels', () => {
        // The builder canvas paints cards with inline styles, so it reads
        // `cssVar` rather than the class strings. That column did not exist
        // until 2026-09-06, which is precisely why nodeTypeColors.js kept a
        // private copy of this table with `running` still amber in it — one
        // view drawing a step blue in its run panel and amber on its canvas.
        expect(STATUS_TOKENS.running.cssVar).toBe('var(--type-ai)');
        expect(STATUS_TOKENS.running.cssVar).not.toBe(STATUS_TOKENS.paused.cssVar);
        expect(STATUS_TOKENS.running.cssVar).not.toBe(STATUS_TOKENS.awaiting_approval.cssVar);
        expect(STATUS_TOKENS.paused.cssVar).toBeNull();
    });

    it('leaves a paused item as quiet as a queued one — neither is a problem', () => {
        // The Cowork artboard paints "Gepauzeerd" and "In wachtrij" in the
        // same --text-tertiary on purpose; the icon and the word separate them.
        expect(STATUS_TOKENS.paused.solid).toBe(STATUS_TOKENS.queued.solid);
        expect(STATUS_TOKENS.paused.badge).toBe(STATUS_TOKENS.queued.badge);
        expect(STATUS_TOKENS.paused.icon).not.toBe(STATUS_TOKENS.queued.icon);
        expect(STATUS_TOKENS.paused.labelKey).not.toBe(STATUS_TOKENS.queued.labelKey);
    });
});

describe('the skip matrix', () => {
    /** Every reason code the runner can set, and the colour it earns. */
    const EXPECTED: Record<string, 'configured' | 'no_work' | 'pinned'> = {
        // Grey — the step was never meant to run this time.
        disabled: 'configured',
        note: 'configured',
        // Amber — the step ran and had nothing to do.
        arrayref_unresolved: 'no_work',
        overref_unresolved: 'no_work',
        aggregate_field_absent: 'no_work',
        summarize_field_absent: 'no_work',
        datetime_unresolved_input: 'no_work',
        datatable_column_unknown: 'no_work',
        datatable_filter_unresolved: 'no_work',
        datatable_values_unresolved: 'no_work',
        knowledge_write_empty: 'no_work',
        knowledge_write_no_kb: 'no_work',
        knowledge_write_too_long: 'no_work',
        knowledge_write_refused: 'no_work',
        no_service_email: 'no_work',
        no_owner_email: 'no_work',
        not_sent: 'no_work',
        // Its own status, not a skip at all in the UI.
        pinned: 'pinned',
    };

    it('classifies every reason code, one at a time', () => {
        for (const [reason, group] of Object.entries(EXPECTED)) {
            expect(SKIP_REASONS[reason], reason).toBe(group);
        }
        expect(Object.keys(SKIP_REASONS).sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    it('turns each code into the right token', () => {
        for (const [reason, group] of Object.entries(EXPECTED)) {
            const token = tokenForSkip(SKIP_REASONS[reason]);
            if (group === 'no_work') expect(token, reason).toBe(STATUS_TOKENS.nothing_to_do);
            else if (group === 'pinned') expect(token, reason).toBe(STATUS_TOKENS.pinned);
            else expect(token, reason).toBe(STATUS_TOKENS.skipped);
        }
    });

    it('keeps a switched-off step out of the warning colour', () => {
        // The whole argument for the split: amber on `disabled` puts every
        // automation that has one node switched off permanently on amber, and a
        // warning that is always on is not a warning.
        expect(STATUS_TOKENS.skipped.solid).not.toContain('--warning');
        expect(STATUS_TOKENS.skipped.badge).not.toContain('--warning');
        expect(STATUS_TOKENS.nothing_to_do.solid).toContain('--warning');
        expect(STATUS_TOKENS.nothing_to_do.badge).toContain('--warning');
    });

    it('covers every skippedReason the runner can actually emit', () => {
        // A drift guard, not a restatement: the day someone adds a fifteenth
        // reason on the server, this fails until a person decides whether it
        // is a setting (grey) or an outcome (amber). Deciding by omission is
        // how the whole class of "silent green success" bugs got in.
        // Two spellings: the literal field, and the `skipped(reason, message,
        // …)` helper each exec module defines to keep the code top-level and
        // the sentence on output.skipped.
        const found = new Set<string>();
        for (const file of fs.readdirSync(RUNNER_DIR)) {
            if (!file.endsWith('.js') || /\.test\.js$/.test(file)) continue;
            const src = fs.readFileSync(path.join(RUNNER_DIR, file), 'utf8');
            for (const m of src.matchAll(/skippedReason:\s*'([a-z0-9_]+)'/g)) found.add(m[1]);
            for (const m of src.matchAll(/\bskipped\(\s*'([a-z0-9_]+)'/g)) found.add(m[1]);
        }
        expect(found.size, 'the scan found no reason codes — the path is probably wrong').toBeGreaterThan(10);
        const unclassified = [...found].filter(r => !(r in SKIP_REASONS)).sort();
        expect(unclassified, 'skippedReason codes the runner emits that the table does not classify').toEqual([]);
    });
});

describe('skipGroupOfStep', () => {
    it('believes an explicit skippedReason above everything else', () => {
        // The field the runner already sets. It does not reach a client yet
        // (recordRunStep has no parameter for it and the table no column), so
        // this is the path that lights up the day the server persists it.
        expect(skipGroupOfStep({ status: 'skipped', skippedReason: 'knowledge_write_empty' })).toBe('no_work');
        expect(skipGroupOfStep({ status: 'skipped', skippedReason: 'disabled' })).toBe('configured');
        expect(skipGroupOfStep({ status: 'skipped', skippedReason: 'DISABLED' })).toBe('configured');
        // …and a reason it does not know is not a reason to guess amber.
        expect(skipGroupOfStep({ status: 'skipped', skippedReason: 'invented_later' })).toBeNull();
    });

    it('reads the shape of the output when the reason is missing', () => {
        // execution.js writes `{ disabled: true }` for a switched-off step and
        // nothing else does; the fifteen no-work paths all put a sentence on
        // `output.skipped` through their own skipped() helper.
        expect(skipGroupOfStep({ status: 'skipped', output: { disabled: true } })).toBe('configured');
        expect(skipGroupOfStep({ status: 'skipped', output: { disabled: true, branch: 'yes' } })).toBe('configured');
        expect(skipGroupOfStep({
            status: 'skipped',
            output: { written: false, chunks: 0, skipped: 'There was nothing to write this run.' },
        })).toBe('no_work');
    });

    it('never decides on the words of the sentence, only on its presence', () => {
        // Two different sentences, same answer — a colour that depended on
        // English prose would break on the first rewrite or translation.
        const a = skipGroupOfStep({ status: 'skipped', output: { skipped: 'There was nothing to write this run.' } });
        const b = skipGroupOfStep({ status: 'skipped', output: { skipped: 'niets te doen' } });
        expect(a).toBe('no_work');
        expect(b).toBe('no_work');
        // An empty string claims nothing.
        expect(skipGroupOfStep({ status: 'skipped', output: { skipped: '  ' } })).toBeNull();
        expect(skipGroupOfStep({ status: 'skipped', output: { skipped: 42 } })).toBeNull();
    });

    it('does not read a reason off Object.prototype', () => {
        // `SKIP_REASONS['constructor']` is a function on every object literal,
        // so a status row carrying that word used to be classified as a skip
        // group that is not a skip group.
        for (const reason of ['constructor', '__proto__', 'toString', 'valueOf']) {
            expect(skipGroupOfStep({ status: 'skipped', skippedReason: reason }), reason).toBeNull();
            expect(tokenForStep({ status: 'skipped', skippedReason: reason }), reason).toBe(STATUS_TOKENS.skipped);
        }
    });

    it('says nothing when the row cannot say', () => {
        for (const step of [null, undefined, {}, { status: 'skipped' }, { status: 'skipped', output: null }, { status: 'skipped', output: 'a string' }]) {
            expect(skipGroupOfStep(step as never)).toBeNull();
        }
    });
});

describe('tokenForStep', () => {
    it('separates the switched-off step from the one that had nothing to do', () => {
        const off = tokenForStep({ status: 'skipped', output: { disabled: true } });
        const empty = tokenForStep({ status: 'skipped', output: { skipped: 'nothing to write' } });
        expect(off).toBe(STATUS_TOKENS.skipped);
        expect(empty).toBe(STATUS_TOKENS.nothing_to_do);
        expect(off.solid).not.toBe(empty.solid);
        expect(off.labelKey).not.toBe(empty.labelKey);
    });

    it('leaves a skip it cannot explain grey', () => {
        // Amber is a claim. Without evidence the row does not make it.
        expect(tokenForStep({ status: 'skipped' })).toBe(STATUS_TOKENS.skipped);
        expect(tokenForStep({ status: 'skipped', output: {} })).toBe(STATUS_TOKENS.skipped);
    });

    it('passes every other status straight through to tokenFor', () => {
        for (const status of ['success', 'error', 'failed', 'running', 'queued', 'paused', 'pinned', 'weird_future_status']) {
            expect(tokenForStep({ status, output: { skipped: 'ignored' } }), status).toBe(tokenFor(status));
        }
    });

    it('is safe on a row that is not there', () => {
        expect(tokenForStep(null)).toBe(STATUS_TOKENS.idle);
        expect(tokenForStep(undefined)).toBe(STATUS_TOKENS.idle);
    });
});

describe('the whole vocabulary', () => {
    it('says something different for every status', () => {
        // Two states that read identically are two states a user cannot tell
        // apart — the bug this table exists to prevent, checked across the
        // whole set rather than only on the pair that had it.
        const seen = new Map<string, StatusKey>();
        for (const key of STATUS_KEYS) {
            const token = STATUS_TOKENS[key];
            const fingerprint = `${token.solid}|${token.badge}|${token.icon?.displayName ?? token.icon?.name}|${token.spin}|${token.labelKey}`;
            expect(seen.get(fingerprint), `${key} is indistinguishable from ${seen.get(fingerprint)}`).toBeUndefined();
            seen.set(fingerprint, key);
        }
    });
});
