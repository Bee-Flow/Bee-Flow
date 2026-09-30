/**
 * The retention port held to the web's RetentionPanel.jsx and
 * datatableDisplay.js (agent-hub/src/components/admin/Studio/Datatables).
 * Differential where the web keeps the rule in a pure function (the panel's
 * `defaultField` and `labelOf`, and `expiringSoonCutoffIso`), textual for the
 * panel's constants. When this fails, the web side changed: update the port.
 */

import fs from 'node:fs';

import type { TranslateFn } from '@/core/i18n';
import { AGENT_HUB_SRC, loadWebFunctions, webFileExists } from '@/shared/testing/webModule';

import {
    defaultRetentionField,
    EXPIRING_COUNT_LIMIT,
    EXPIRING_WITHIN_DAYS,
    expiringSoonCutoffIso,
    MAX_RETENTION_DAYS,
    RETENTION_PRESETS,
    retentionFieldLabel,
} from './retention';
import type { Column } from './types';

const DIR = 'components/admin/Studio/Datatables';
const PANEL = `${DIR}/RetentionPanel.jsx`;
const DISPLAY = `${DIR}/datatableDisplay.js`;
const describeIfWeb = webFileExists(PANEL) && webFileExists(DISPLAY) ? describe : describe.skip;

const t: TranslateFn = (_key, fallback) => fallback;
const col = (key: string, type: Column['type'], name = ''): Column => ({ id: `fld_${key}`, key, name, type, options: [], required: false, unique: false });

const COLUMN_SETS: Column[][] = [
    [],
    [col('email', 'text', 'E-mail')],
    [col('email', 'text'), col('signed_at', 'datetime', 'Signed on'), col('seen_at', 'date', 'Last seen')],
    [col('seen_at', 'date'), col('signed_at', 'datetime', 'Signed on')],
    [col('fetched_at', 'datetime', 'Fetched at')],
];
/** Every kind the web's defaultField answers the same way; form_answers is the port's one addition (see retention.ts). */
const KINDS = [null, 'http_cache', 'nextcloud_table', 'spreadsheet_file'];

type Web = {
    defaultField: (table: { managedKind: string | null }, columns: Column[]) => string;
    labelOf: (t: TranslateFn, columns: Column[], key: string | null) => string;
    expiringSoonCutoffIso: (days: number | null, within: number, now: number) => string | null;
};

function source(rel: string): string {
    return fs.readFileSync(`${AGENT_HUB_SRC}/${rel}`, 'utf8');
}

/** `const NAME = <literal>;` out of a web file, as JSON. */
function constant(src: string, name: string): unknown {
    const match = new RegExp(`^const ${name} = ([^;]+);`, 'm').exec(src);
    if (!match) throw new Error(`const ${name} not found`);
    return JSON.parse(match[1] as string);
}

function loadWeb(): Web {
    const dayMs = constant(source(DISPLAY), 'DAY_MS');
    return {
        ...loadWebFunctions<Pick<Web, 'defaultField' | 'labelOf'>>(PANEL, ['defaultField', 'labelOf']),
        ...loadWebFunctions<Pick<Web, 'expiringSoonCutoffIso'>>(DISPLAY, ['expiringSoonCutoffIso'], { DAY_MS: dayMs }),
    };
}

describeIfWeb('retention, against the web', () => {
    const web = loadWeb();
    const panel = source(PANEL);

    it('offers the same presets, cap, look-ahead and count page', () => {
        expect([...RETENTION_PRESETS]).toEqual(constant(panel, 'PRESETS'));
        expect(MAX_RETENTION_DAYS).toBe(constant(panel, 'MAX_DAYS'));
        expect(EXPIRING_WITHIN_DAYS).toBe(constant(panel, 'SOON_DAYS'));
        expect(EXPIRING_COUNT_LIMIT).toBe(constant(panel, 'COUNT_LIMIT'));
    });

    it('proposes the same column for a new window', () => {
        for (const managedKind of KINDS) {
            for (const columns of COLUMN_SETS) {
                expect({ managedKind, columns: columns.map((c) => c.key), port: defaultRetentionField({ managedKind }, columns) })
                    .toEqual({ managedKind, columns: columns.map((c) => c.key), port: web.defaultField({ managedKind }, columns) });
            }
        }
    });

    it('names the column in a sentence the same way', () => {
        for (const columns of COLUMN_SETS) {
            for (const key of [null, '', 'signed_at', 'seen_at', 'created_at', 'fetched_at']) {
                expect(retentionFieldLabel(t, columns, key)).toBe(web.labelOf(t, columns, key));
            }
        }
    });

    it('works out the same "about to expire" cutoff', () => {
        const now = Date.parse('2026-09-27T12:00:00.000Z');
        for (const days of [null, 0, 1, 5, 7, 30, 90, 3650]) {
            for (const within of [0, 7]) {
                expect(expiringSoonCutoffIso(days, within, now)).toBe(web.expiringSoonCutoffIso(days, within, now));
            }
        }
    });
});
