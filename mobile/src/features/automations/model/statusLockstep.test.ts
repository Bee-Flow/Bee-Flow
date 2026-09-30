/**
 * The status vocabulary, measured against the web app's own table.
 *
 * status.ts (once format.ts) says in as many words that it is "a port of
 * agent-hub/src/components/shared/statusTokens.ts". Nothing checked that, and
 * the port had already drifted: `pinned` and `info` were missing entirely, so
 * a pinned step read as "Idle" on the phone and "Frozen data" on the desktop —
 * two screens of one product disagreeing about what happened, which is the one
 * thing the duplicated table exists to prevent. `running` and `paused` shared
 * a tone here long after the design said they must not.
 *
 * The precedent is next door: catalogLockstep.test.ts requires the server's
 * componentSpecs.js directly, and core/theme/tokens.test.ts parses index.css. This
 * one PARSES rather than imports, because statusTokens.ts is TypeScript with
 * Lucide and Tailwind in it — nothing this jest project can load. What it
 * compares is the part that must agree: which statuses exist, what each one is
 * KEYED as, and what English it falls back to.
 *
 * What it deliberately does NOT compare is the colour. A Tailwind class
 * string and a React Native tone cannot be equal; TONE_MAP below records the
 * intended correspondence instead, so a colour decision made on one client
 * has to be repeated here by a person rather than forgotten. The glyph IS
 * compared: both clients draw Lucide now, so a status wears the same icon on
 * both — resolved through lucide-react-native's own alias table, because the
 * web imports older names (CheckCircle2) for what the phone calls CircleCheck.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SKIP_REASONS, statusToken, type StatusTone } from './format';

const WEB_TABLE = path.resolve(
    __dirname,
    '../../../../../agent-hub/src/components/shared/statusTokens.ts',
);

/** Each web row, as the pair the two clients must agree on. */
function webRows(src: string): { key: string; labelKey: string; labelEn: string }[] {
    const rows: { key: string; labelKey: string; labelEn: string }[] = [];
    // `    success: {` … `labelKey: 'x',` … `labelEn: 'Finished',` … `},`
    const re = /^\s{4}([a-z_]+):\s*\{([\s\S]*?)^\s{4}\},/gm;
    for (const m of src.matchAll(re)) {
        const body = m[2] ?? '';
        const labelKey = /labelKey:\s*'([^']+)'/.exec(body)?.[1];
        const labelEn = /labelEn:\s*'([^']+)'/.exec(body)?.[1];
        if (labelKey && labelEn) rows.push({ key: m[1] as string, labelKey, labelEn });
    }
    return rows;
}

/**
 * The web table factors its shared neutral recipe into three constants
 * (`NEUTRAL_SOLID` and friends), so four rows never spell `var(--text-tertiary)`
 * out. Expand them before matching, rather than forcing the other file to
 * repeat itself for a test's convenience.
 */
function expandConstants(src: string, body: string): string {
    let out = body;
    for (const m of src.matchAll(/^const ([A-Z_]+) = '([^']*)';$/gm)) {
        out = out.split(m[1] as string).join(m[2] as string);
    }
    return out;
}

/** The web's SKIP_REASONS table, code → group. */
function webSkipReasons(src: string): Record<string, string> {
    const block = /export const SKIP_REASONS[\s\S]*?\}\);/.exec(src)?.[0] ?? '';
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/^\s+([a-z_]+):\s*'([a-z_]+)',/gm)) {
        out[m[1] as string] = m[2] as string;
    }
    return out;
}

/** The Lucide component each web row draws: `icon: CheckCircle2,`. */
function webIcons(src: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of src.matchAll(/^\s{4}([a-z_]+):\s*\{([\s\S]*?)^\s{4}\},/gm)) {
        const icon = /icon:\s*([A-Za-z0-9]+),/.exec(m[2] ?? '')?.[1];
        if (icon) out[m[1] as string] = icon;
    }
    return out;
}

/** Lucide export name → icon file, from the package barrel (aliases included). */
function lucideFile(): (name: string) => string | undefined {
    const barrel = path.resolve(__dirname, '../../../../node_modules/lucide-react-native/dist/esm/lucide-react-native.js');
    const files = new Map<string, string>();
    for (const m of fs.readFileSync(barrel, 'utf8').matchAll(/export \{([^}]*)\} from '\.\/icons\/([a-z0-9-]+)\.js'/g)) {
        for (const part of (m[1] ?? '').split(',')) files.set(part.trim().replace(/^default as /, ''), m[2] as string);
    }
    return (name) => files.get(name);
}

const src = fs.existsSync(WEB_TABLE) ? fs.readFileSync(WEB_TABLE, 'utf8') : null;

// The mobile package is publishable on its own and someone may check it out
// without the sibling. Skipping loudly beats failing for the wrong reason.
const describeIfWeb = src ? describe : describe.skip;

describeIfWeb('the phone speaks the web app\'s status vocabulary', () => {
    const rows = webRows(src as string);

    it('actually read the web table (a broken parse would pass vacuously)', () => {
        expect(rows.length).toBeGreaterThanOrEqual(15);
        expect(rows.map((r) => r.key)).toContain('nothing_to_do');
    });

    it('knows every status the web app knows', () => {
        // `statusToken` degrades an unknown status to `idle`, so a row the
        // phone has never heard of shows up as a mismatched key rather than
        // as a crash — which is exactly how `pinned` went missing unnoticed.
        const missing = rows
            .filter((r) => statusToken(r.key).labelKey !== r.labelKey)
            .map((r) => `${r.key} → ${statusToken(r.key).labelKey}, expected ${r.labelKey}`);
        expect(missing).toEqual([]);
    });

    it('uses the same i18n key and the same English for each', () => {
        for (const row of rows) {
            const token = statusToken(row.key);
            expect([row.key, token.labelKey, token.labelEn]).toEqual([row.key, row.labelKey, row.labelEn]);
        }
    });

    it('maps the same three server aliases', () => {
        for (const [alias, canonical] of [
            ['failed', 'error'],
            ['awaiting_confirm', 'awaiting_approval'],
            ['paused_breakpoint', 'paused'],
        ] as const) {
            const web = rows.find((r) => r.key === canonical);
            expect([alias, statusToken(alias).labelKey]).toEqual([alias, web?.labelKey]);
        }
    });

    it('classifies every skip reason the same way', () => {
        expect(webSkipReasons(src as string)).toEqual({ ...SKIP_REASONS });
    });

    it('draws the same Lucide glyph for each', () => {
        const icons = webIcons(src as string);
        const fileOf = lucideFile();
        expect(Object.keys(icons).sort()).toEqual(rows.map((r) => r.key).sort());
        const differ = Object.entries(icons)
            .filter(([key, icon]) => !fileOf(icon) || fileOf(icon) !== fileOf(statusToken(key).icon))
            .map(([key, icon]) => `${key}: web ${icon}, phone ${statusToken(key).icon}`);
        expect(differ).toEqual([]);
    });
});

/**
 * The intended colour correspondence, written down because it cannot be
 * derived: the web says `text-[var(--success-ink)]`, the phone says a tone
 * that the UI kit's tones.ts turns into a raw/ink pair (`theme.colors.success`
 * and `successInk`).
 *
 * `pinned` and its twin `edited` wore the accent while the phone's palette had
 * no `--pinned`; the palette is generated from the web's index.css now, so
 * they wear the web's cyan like everything else.
 */
const TONE_MAP: Record<string, { webToken: string; tone: StatusTone }> = {
    success: { webToken: '--success', tone: 'success' },
    error: { webToken: '--error', tone: 'error' },
    running: { webToken: '--type-ai', tone: 'ai' },
    queued: { webToken: '--text-tertiary', tone: 'neutral' },
    paused: { webToken: '--text-tertiary', tone: 'neutral' },
    cancelled: { webToken: '--text-tertiary', tone: 'neutral' },
    awaiting_approval: { webToken: '--warning', tone: 'warning' },
    awaiting_form: { webToken: '--warning', tone: 'warning' },
    skipped: { webToken: '--text-tertiary', tone: 'neutral' },
    nothing_to_do: { webToken: '--warning', tone: 'warning' },
    handled_error: { webToken: '--warning', tone: 'warning' },
    pinned: { webToken: '--pinned', tone: 'pinned' },
    edited: { webToken: '--pinned', tone: 'pinned' },
    warning: { webToken: '--warning', tone: 'warning' },
    info: { webToken: '--type-ai', tone: 'ai' },
    idle: { webToken: '--text-tertiary', tone: 'neutral' },
};

describeIfWeb('the two clients paint the same statuses the same way', () => {
    const rows = webRows(src as string);

    it('has a recorded correspondence for every status', () => {
        expect(Object.keys(TONE_MAP).sort()).toEqual(rows.map((r) => r.key).sort());
    });

    for (const [key, { webToken, tone }] of Object.entries(TONE_MAP)) {
        it(`${key}: ${webToken} on the web, "${tone}" here`, () => {
            expect(statusToken(key).tone).toBe(tone);
            // The web row's own classes must still read that token, or the
            // mapping above is a description of something that changed.
            const raw = new RegExp(`^\\s{4}${key}:\\s*\\{([\\s\\S]*?)^\\s{4}\\},`, 'm').exec(src as string)?.[1];
            const body = expandConstants(src as string, raw ?? '');
            expect([key, body.includes(`var(${webToken})`)]).toEqual([key, true]);
        });
    }
});
