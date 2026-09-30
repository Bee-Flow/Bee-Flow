/**
 * The catalogue is a port of agent-hub/src/config/piiCategories.ts, and the
 * group keys of the matrix (parts/categoryMatrixModel.ts, where CategoryMatrix
 * keeps its data): ids, order, groups and label keys must
 * match, because the ids are what `piiDetectionCategories` stores and what
 * the guard is asked for. When this fails, the web changed: port it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { PII_CATALOG, PII_GROUP_KEYS } from './piiCatalog';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src');
const catalog = fs.readFileSync(path.join(WEB, 'config/piiCategories.ts'), 'utf8');
const matrix = fs.readFileSync(
    path.join(WEB, 'components/admin/security/guardrails/orgShield/parts/categoryMatrixModel.ts'),
    'utf8',
);

it('lists the web catalogue in order, with its groups and label keys', () => {
    const rows = [...catalog.matchAll(/\{\s*id:\s*'([^']+)',\s*group:\s*'([^']+)',[^}]*i18nKey:\s*'([^']+)'/g)].map(
        (m) => ({ id: m[1], group: m[2], i18nKey: m[3] }),
    );
    expect(rows.length).toBe(21);
    expect(PII_CATALOG.map(({ id, group, i18nKey }) => ({ id, group, i18nKey }))).toEqual(rows);
});

it('uses the matrix group keys', () => {
    for (const g of PII_GROUP_KEYS) {
        expect(matrix).toContain(`${g.group.includes(' ') ? `'${g.group}'` : g.group}: ['${g.key}', '${g.fallback}']`);
    }
});
