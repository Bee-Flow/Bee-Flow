/**
 * The ports held to their originals, read as text: the web rail's section
 * ids and order (agent-hub admin/compliance/sections.js), the web settings
 * table's columns and kinds (pages/settings/settingsFields.js), the option
 * values against the server's zod enums, and the settings copy's keys
 * against both dictionaries (they travel through `L(…)`, which the i18n
 * guard does not read).
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';

import { AUDIT_STATUSES, INCIDENT_SEVERITIES, INCIDENT_STATUSES, NC_STATUSES, OBJECTIVE_STATUSES, OBLIGATION_KINDS, RISK_STATUSES, SOA_DECISIONS, TREATMENT_OPTIONS } from './choices';
import { SECTIONS } from './sections';
import { SETTING_GROUPS } from './settingsFields';

const REPO = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const WEB = 'agent-hub/src/components/admin/compliance';

describe('the sections', () => {
    it('are the web rail, in its order', () => {
        const src = read(`${WEB}/sections.js`);
        const ids = [...src.matchAll(/(?:fw|reg)\('([a-z_0-9]+)'|id: '([a-z_]+)', group:/g)].map((m) => m[1] ?? m[2]);
        expect(SECTIONS.map((s) => s.id)).toEqual(ids);
    });
});

describe('the settings form', () => {
    it('has the web table’s groups, columns and kinds', () => {
        const src = read(`${WEB}/pages/settings/settingsFields.js`);
        const web = [...src.matchAll(/name: '([a-z0-9_]+)', kind: '([a-z]+)'/g)]
            .map((m) => [m[1], m[2]] as const)
            .filter(([, kind]) => kind !== 'userfill');
        const KIND: Record<string, string> = { email: 'email', url: 'url' };
        const phone = SETTING_GROUPS.flatMap((g) => g.fields).map((f) => [f.name, KIND[f.kind] ?? f.kind] as const);
        expect(phone).toEqual(web);
        const groups = [...src.matchAll(/id: '([a-z_0-9]+)',\n\s+framework:/g)].map((m) => m[1]);
        expect(SETTING_GROUPS.map((g) => g.id)).toEqual(groups);
    });

    it('borrows only keys both dictionaries hold', () => {
        const client = readDict(CLIENT_DICT);
        const server = readDict(SERVER_DICT);
        const src = read('mobile/src/features/compliance/model/settingsFields.ts');
        const keys = [...src.matchAll(/L\('([a-z0-9_.]+)'/g)].map((m) => m[1] as string);
        expect(keys.length).toBeGreaterThan(70);
        for (const key of keys) expect({ key, client: client.has(key), server: server.has(key) }).toEqual({ key, client: true, server: true });
    });
});

describe('the option tables', () => {
    const values = (list: readonly { value: string }[]) => list.map((c) => `'${c.value}'`).join(', ');

    it.each([
        ['incident severities', INCIDENT_SEVERITIES, 'server/routes/compliance/incidents.js', 'const SEVERITIES = ['],
        ['incident statuses', INCIDENT_STATUSES, 'server/routes/compliance/incidents.js', 'const STATUSES = ['],
        ['risk statuses', RISK_STATUSES, 'server/routes/compliance/isoProcess.js', 'const RISK_STATUSES = ['],
        ['treatments', TREATMENT_OPTIONS, 'server/routes/compliance/isoProcess.js', 'const TREATMENT_OPTIONS = ['],
        ['audit statuses', AUDIT_STATUSES, 'server/routes/compliance/isoProcess.js', 'const AUDIT_STATUSES = ['],
        ['NC statuses', NC_STATUSES, 'server/routes/compliance/isoProcess.js', 'const NC_STATUSES = ['],
        ['objective statuses', OBJECTIVE_STATUSES, 'server/routes/compliance/isoProcess.js', 'const OBJECTIVE_STATUSES = ['],
        ['SoA decisions', SOA_DECISIONS, 'server/routes/compliance/isoSoa.js', 'const DECISIONS = ['],
    ])('%s are the server enum', (_name, list, file, prefix) => {
        expect(read(file)).toContain(`${prefix}${values(list)}]`);
    });

    it('obligation kinds are the server enum', () => {
        const src = read('server/routes/compliance/isoProcess.js').replace(/\s+/g, ' ');
        expect(src).toContain(`const OBLIGATION_KINDS = [ ${values(OBLIGATION_KINDS)}, ]`);
    });
});
