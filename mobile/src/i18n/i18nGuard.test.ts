/**
 * The phone's half of the i18n guard.
 *
 * `agent-hub/src/i18n/i18nGuard.test.js` walks `agent-hub/src` and nothing
 * else, so every rule it enforces stops at the browser. This file is the same
 * idea pointed at `mobile/`, with the one difference the two clients actually
 * have: the web looks a key up in a bundled dictionary and renders the raw key
 * when it is missing, while `t(key, fallback)` here ALWAYS carries the English
 * literal (see store.ts). A missing key on the phone is therefore invisible —
 * which is why it needs a test rather than a bug report.
 *
 * Two checks.
 *
 * 1. NO HARD-CODED USER-FACING STRING in a converted area. Five shapes, each
 *    one a way a string reaches the screen without passing the catalogue:
 *
 *      <Text>Save</Text>              a JSX text child
 *      title="No chats yet"           a user-facing prop
 *      { title: 'You are offline' }   the same names as object properties,
 *                                     which is where this app keeps the copy
 *                                     it composes before rendering — every
 *                                     error sentence, every menu label, every
 *                                     schedule option
 *      Alert.alert('Delete?', '…')    a system dialog
 *      toast('Task deleted')          the in-app toast
 *
 *    Areas that still carry hard-coded text are on the UNCONVERTED ledger with
 *    their exact count, so an unconverted screen cannot gain strings and a
 *    converted one cannot lose its translation. An area that is on NO ledger
 *    line must be clean — so a new directory starts translated rather than
 *    starting as debt somebody has to notice.
 *
 * 2. EVERY BORROWED KEY EXISTS IN BOTH ENGLISH DICTIONARIES, or is on the
 *    PENDING_KEYS ledger with a reason. The phone reads the SERVER's
 *    catalogue (/api/languages/user/strings/<locale>) and the browser reads
 *    the client's, so a key in only one of them is already broken for
 *    somebody — and on the phone it is broken silently, because the fallback
 *    renders.
 *
 *    "Borrowed" is every key except `mobile.*`. Reusing the web's own key
 *    (`common.cancel`, `settings.appearance`) is the whole point — a string an
 *    administrator has already translated for the browser then appears on the
 *    phone for free — and this check is what stops a rename on that side from
 *    turning the phone silently English.
 *
 *    `mobile.*` is this package's own namespace, per I18N-CONVENTIES §1.3
 *    ("new key in your OWN namespace"), for text that exists nowhere on the
 *    web. It is empty in both dictionaries on purpose: this package may not
 *    append to them (§serieel — they belong to one stage at a time), so those
 *    keys render their English fallback until a stage that owns the
 *    dictionaries lands them. Checking them against the dictionaries would
 *    therefore assert a thing that cannot be true yet, which is why they are
 *    exempt rather than 90 lines of ledger.
 *
 * Related, and deliberately not merged into this file:
 * `src/features/settings/sitemap.i18n.test.ts` pins the nineteen keys the More
 * tab borrows, and says something this cannot — that those nineteen are frozen
 * by an agreement recorded in .claude/handoff/I18N-CONVENTIES.md §1.4. Check 2
 * covers them as a subset; that test says why they may not be renamed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from './dictionaryText';

const HERE = __dirname;
const MOBILE = path.resolve(HERE, '../..');

/** This package's own namespace. Empty in both dictionaries — see the header. */
const OWN_NAMESPACE = 'mobile';

// ---------------------------------------------------------------------------
// Finding hard-coded text
// ---------------------------------------------------------------------------

/**
 * Text between a `>` and a `</`. Requiring the CLOSING tag is what keeps
 * TypeScript out of the results: `useState<Task | null>(null)` and `=> (` both
 * produce a `>` followed by prose-looking characters, and neither is followed
 * by `</`.
 */
const TEXT_CHILD = />([^<>{}]*[A-Za-z]{2}[^<>{}]*)<\//g;

/**
 * Props that render. Curated rather than "every string prop": `testID`,
 * `name` (an icon), `href`, `key` and the style props are all strings a user
 * never reads, and a guard that flags them is a guard people switch off.
 */
const TEXT_PROPS = [
    'title', 'label', 'placeholder', 'accessibilityLabel', 'accessibilityHint',
    'subtitle', 'message', 'confirmLabel', 'cancelLabel', 'emptyText',
    'helperText', 'description', 'headerTitle', 'submitLabel', 'caption',
    'hint', 'note', 'heading', 'footer', 'actionLabel', 'emptyTitle',
    'shareTitle',
];
const PROP_RX = new RegExp(
    `\\b(${TEXT_PROPS.join('|')})=(["'])([^"']*[A-Za-z]{2}[^"']*)\\2`, 'g',
);

/** Both arguments: Alert.alert renders the title AND the body. */
const ALERT_RX =
    /\bAlert\.alert\(\s*(['"])([^'"]*[A-Za-z]{2}[^'"]*)\1(?:\s*,\s*(['"])([^'"]*[A-Za-z]{2}[^'"]*)\3)?/g;

/** Only the first argument; the second is a tone ('success' | 'error' | …). */
const TOAST_RX = /\btoast\(\s*(['"])([^'"]*[A-Za-z]{2}[^'"]*)\1/g;

/**
 * The same names as OBJECT PROPERTIES. Anchored on `{`, `,` or `(` so a type
 * annotation or a destructure cannot match, and on a string LITERAL so
 * `title: item.name` — data, not copy — cannot either.
 */
const OBJ_RX = new RegExp(
    `(?:^|[{,(]\\s*)(${TEXT_PROPS.join('|')}):\\s*(["'])([^"']*[A-Za-z]{2}[^"']*)\\2`, 'gm',
);

/**
 * Blank out comments before matching, preserving offsets so a future reporter
 * can still point at a line. An example in a doc comment is not a call site —
 * and this package's headers are long and full of quoted UI copy.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1: string) =>
            p1 + ' '.repeat(m.length - p1.length));
}

export interface Finding { kind: string; text: string }

export function findHardCoded(src: string): Finding[] {
    const body = stripComments(src);
    const out: Finding[] = [];
    for (const m of body.matchAll(TEXT_CHILD)) {
        const text = (m[1] ?? '').trim();
        if (text) out.push({ kind: 'jsx-text', text });
    }
    for (const m of body.matchAll(PROP_RX)) {
        out.push({ kind: `prop:${m[1]}`, text: m[3] ?? '' });
    }
    for (const m of body.matchAll(ALERT_RX)) {
        out.push({ kind: 'Alert.alert', text: m[2] ?? '' });
        if (m[4]) out.push({ kind: 'Alert.alert', text: m[4] });
    }
    for (const m of body.matchAll(TOAST_RX)) {
        out.push({ kind: 'toast', text: m[2] ?? '' });
    }
    for (const m of body.matchAll(OBJ_RX)) {
        out.push({ kind: `obj:${m[1]}`, text: m[3] ?? '' });
    }
    return out;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') yield* walk(p);
        } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
            yield p;
        }
    }
}

/**
 * The unit the ledger counts in: a screen folder under `app/`, or a feature
 * under `src/features/`. Small enough that one commit finishes one, big enough
 * that the ledger stays readable.
 */
export function areaOf(rel: string): string {
    const parts = rel.split('/');
    if (parts[0] === 'app') return parts.length > 2 ? `app/${parts[1]}` : 'app/(root)';
    if (parts[0] === 'src' && parts[1] === 'features') return `src/features/${parts[2]}`;
    return `${parts[0]}/${parts[1] ?? ''}`;
}

interface SourceFile { rel: string; area: string; src: string }

function collect(): SourceFile[] {
    const out: SourceFile[] = [];
    for (const root of ['app', 'src']) {
        for (const file of walk(path.join(MOBILE, root))) {
            const rel = path.relative(MOBILE, file).replace(/\\/g, '/');
            out.push({ rel, area: areaOf(rel), src: fs.readFileSync(file, 'utf8') });
        }
    }
    return out;
}

const sources = collect();

// ---------------------------------------------------------------------------
// LEDGER — areas that still render hard-coded English.
//
// A line is a debt with a number on it, not a permission slip: the count is
// exact, so an unconverted screen cannot quietly gain strings, and finishing
// one means deleting its line. "The ledger does not rot" below fails on a line
// whose area is already clean, so this list cannot outlive the debt.
//
// Everything NOT listed must be clean. That is the important direction: a new
// screen folder is born covered, and has to be written through t() rather than
// added here.
// ---------------------------------------------------------------------------
const UNCONVERTED = new Map<string, number>([
    ['app/(onboarding)', 86],
    ['app/(root)', 29],
    ['app/(tabs)', 73],
    ['app/admin', 39],
    ['app/agents', 43],
    ['app/approvals', 15],
    ['app/apps', 6],
    ['app/automations', 69],
    // 47 -> 44 and src/features/chat 42 -> 45 on the same commit: the three
    // strings did not disappear, they moved. `app/chat/[id]/details.tsx` was
    // split and its hook now lives in src/features/chat/useChatDetails.ts. The
    // total is 89 either way, which is how you can tell a refactor from a
    // regression here — and why the ledger is per area and exact.
    ['app/chat', 44],
    ['app/cowork', 10],
    ['app/documents', 18],
    ['app/forms', 21],
    ['app/integrations', 29],
    ['app/knowledge', 32],
    ['app/mcp', 24],
    ['app/memory', 12],
    ['app/notebooks', 33],
    ['app/org', 69],
    ['app/projects', 18],
    ['app/recordings', 47],
    ['app/settings', 228],
    ['app/skills', 26],
    ['app/support', 33],
    ['app/tasks', 15],
    ['app/templates', 16],
    ['app/usage', 27],
    ['app/webpages', 45],
    ['src/features/agents', 1],
    ['src/features/automate', 54],
    ['src/features/chat', 45],
    ['src/features/cowork', 21],
    ['src/features/library', 64],
    ['src/features/notifications', 27],
    ['src/features/onboarding', 22],
    ['src/features/publishing', 29],
    ['src/features/recording', 64],
    ['src/features/settings', 214],
    ['src/features/skills', 22],
]);

/**
 * KEY LEDGER — keys the phone asks for that are not in both dictionaries.
 *
 * Every entry renders its English fallback today, so nothing looks broken; it
 * is simply untranslatable, which on a privacy product sold into Dutch
 * organisations is a visible defect rather than a cosmetic one. They are
 * listed rather than fixed here because the two dictionaries belong to one
 * stage at a time (I18N-CONVENTIES §serieel) and `mobile/` may not append to
 * them. Landing a key = deleting its line; "the ledger does not rot" fails on
 * a line that is no longer needed.
 */
const PENDING_KEYS = new Map<string, string>([
    ['composer.placeholder', 'in neither dictionary — the chat composer placeholder has never been translatable'],
    ['starter.welcome_2', 'client only; the phone reads the SERVER catalogue, so this suggestion is always English'],
    ['starter.welcome_3', 'client only; same'],
    ['starter.welcome_7', 'client only; same'],
]);

// ---------------------------------------------------------------------------
// The dictionaries
// ---------------------------------------------------------------------------

// Both dictionaries are read as text by ./dictionaryText (shared with
// sitemap.i18n.test.ts).

const client = readDict(CLIENT_DICT);
const server = readDict(SERVER_DICT);

/** `t('key', 'English')` and the `i18nKey:` carriers that travel as data. */
const KEY_RX = /\bt\(\s*(['"])([a-z0-9_]+(?:[.\-][a-z0-9_.\-]*[a-z0-9_])+)\1/g;
const DATA_KEY_RX = /\bi18nKey:\s*(['"])([a-z0-9_]+(?:[.\-][a-z0-9_.\-]*[a-z0-9_])+)\1/g;

function keysInUse(): Map<string, string> {
    const out = new Map<string, string>();
    for (const { rel, src } of sources) {
        for (const re of [KEY_RX, DATA_KEY_RX]) {
            for (const m of src.matchAll(re)) {
                const key = m[2] as string;
                if (!out.has(key)) out.set(key, rel);
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------

describe('the mobile tree is readable at all', () => {
    it('found the screens and both dictionaries', () => {
        // Without this every check below could pass by walking nothing.
        expect(sources.length).toBeGreaterThan(150);
        expect(client.size).toBeGreaterThan(5000);
        expect(server.size).toBeGreaterThan(5000);
    });
});

describe('no hard-coded user-facing text outside the ledger', () => {
    const byArea = new Map<string, Finding[]>();
    const whereByArea = new Map<string, Map<string, number>>();
    for (const { rel, area, src } of sources) {
        const found = findHardCoded(src);
        if (!byArea.has(area)) byArea.set(area, []);
        (byArea.get(area) as Finding[]).push(...found);
        if (found.length) {
            if (!whereByArea.has(area)) whereByArea.set(area, new Map());
            (whereByArea.get(area) as Map<string, number>).set(rel, found.length);
        }
    }

    const areas = [...byArea.keys()].sort();

    it.each(areas.filter((a) => !UNCONVERTED.has(a)))(
        '%s renders every string through t()',
        (area) => {
            const found = byArea.get(area) ?? [];
            const detail = found
                .slice(0, 12)
                .map((f) => `  [${f.kind}] ${f.text}`)
                .join('\n');
            expect(
                `${area}: ${found.length} hard-coded string(s)\n${detail}`,
            ).toBe(`${area}: 0 hard-coded string(s)\n`);
        },
    );

    it.each([...UNCONVERTED.keys()].sort())(
        '%s is still on the ledger, at exactly the recorded count',
        (area) => {
            const actual = (byArea.get(area) ?? []).length;
            const recorded = UNCONVERTED.get(area) as number;
            // Equality, not "<=": the number is the debt, and a number that is
            // allowed to be stale stops being a measurement.
            expect({ area, actual }).toEqual({ area, actual: recorded });
        },
    );

    it('the ledger does not rot', () => {
        const done = [...UNCONVERTED.keys()].filter((a) => (byArea.get(a) ?? []).length === 0);
        expect({ areasToRemoveFromTheLedger: done }).toEqual({ areasToRemoveFromTheLedger: [] });

        const unknown = [...UNCONVERTED.keys()].filter((a) => !byArea.has(a));
        expect({ areasThatNoLongerExist: unknown }).toEqual({ areasThatNoLongerExist: [] });
    });
});

describe('every key the phone borrows still exists on the other side', () => {
    const inUse = keysInUse();
    const borrowed = [...inUse.keys()].filter((k) => !k.startsWith(`${OWN_NAMESPACE}.`)).sort();
    const own = [...inUse.keys()].filter((k) => k.startsWith(`${OWN_NAMESPACE}.`)).sort();

    it('reads keys at all', () => {
        expect(inUse.size).toBeGreaterThan(3);
        expect(borrowed.length).toBeGreaterThan(3);
    });

    it.each(borrowed.map((k) => [k, inUse.get(k) as string]))(
        '%s (%s) is in both English dictionaries',
        (key, where) => {
            if (PENDING_KEYS.has(key)) return;
            expect({ key, where, client: client.has(key), server: server.has(key) })
                .toEqual({ key, where, client: true, server: true });
        },
    );

    it('the key ledger does not rot', () => {
        const landed = [...PENDING_KEYS.keys()].filter((k) => client.has(k) && server.has(k));
        expect({ keysToRemoveFromTheLedger: landed }).toEqual({ keysToRemoveFromTheLedger: [] });

        const gone = [...PENDING_KEYS.keys()].filter((k) => !inUse.has(k));
        expect({ keysNoLongerUsed: gone }).toEqual({ keysNoLongerUsed: [] });
    });

    it(`${OWN_NAMESPACE}.* keys are shaped like keys`, () => {
        // Not checked against the dictionaries — see the header. What IS worth
        // pinning is the shape, because a key that reads like a sentence is a
        // key somebody typed into the wrong argument, and `t()` would then
        // render the FALLBACK of a key that can never be filled.
        const malformed = own.filter((k) => !/^mobile\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(k));
        expect({ malformed }).toEqual({ malformed: [] });
    });
});
