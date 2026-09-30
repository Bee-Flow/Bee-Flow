/**
 * The management payloads through the allow-list: whatever the server sends,
 * a screen gets the stated shape — ids never undefined, versions numbers,
 * lists arrays — and a payload that is not the expected object degrades to
 * defaults instead of throwing.
 */

import {
    readAppDetail,
    readAppRows,
    readCatalog,
    readCheck,
    readIssues,
    readMyApps,
    readTemplate,
    readTemplates,
    readVersions,
} from './readersApps';

const row = {
    id: 'app1',
    userId: 'u1',
    organizationId: 'o1',
    projectId: null,
    name: 'Intake',
    description: '',
    icon: 'ClipboardList',
    accentColor: null,
    category: null,
    definitionVersion: 4,
    publishedVersion: 3,
    isPublished: true,
    sharedGroups: ['g1'],
    templateId: 'app-request-form',
    templateVersion: 1,
    nextcloudMenu: false,
    publishedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    templateInstallHash: 'abc',
};

describe('app rows', () => {
    it('keeps the spec keys, drops unknown ones and id-less rows', () => {
        const rows = readAppRows({ apps: [row, { name: 'no id' }, 'junk'] });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'app1', definitionVersion: 4, sharedGroups: ['g1'] });
        expect(rows[0]).not.toHaveProperty('templateInstallHash');
    });

    it('reads a count that arrived as a string and defaults a missing version to 1', () => {
        const [app] = readAppRows({ apps: [{ id: 'a', publishedVersion: '7' }] });
        expect(app?.publishedVersion).toBe(7);
        expect(app?.definitionVersion).toBe(1);
        expect(app?.isPublished).toBe(false);
    });

    it('is an empty list for a body that is not a list payload', () => {
        expect(readAppRows(null)).toEqual([]);
        expect(readAppRows('<html>')).toEqual([]);
    });

    it('carries /mine usage and the template-upgrade flag', () => {
        const [mine] = readMyApps({
            apps: [{ ...row, usage: { dbBytes: '2048', dbRatio: 0.2 }, templateUpgrade: { available: true, fromVersion: 1, toVersion: 2 } }],
        });
        expect(mine?.usage).toEqual({ dbBytes: 2048, dbRatio: 0.2 });
        expect(mine?.templateUpgrade).toEqual({ available: true, fromVersion: 1, toVersion: 2 });
        const [bare] = readMyApps({ apps: [row] });
        expect(bare?.usage).toBeNull();
        expect(bare?.templateUpgrade).toBeNull();
    });

    it('reads the detail for an owner and a reader', () => {
        const owner = readAppDetail({ app: { ...row, definition: { screens: [], actions: {} } }, readOnly: false });
        expect(owner?.readOnly).toBe(false);
        expect(owner?.app.definition).toEqual({ screens: [], actions: {} });
        expect(owner?.app.publishedDefinition).toBeNull();
        const reader = readAppDetail({ app: { ...row, publishedDefinition: { screens: [] } }, readOnly: true });
        expect(reader?.app.definition).toBeNull();
        expect(readAppDetail({})).toBeNull();
    });
});

describe('templates and the catalog', () => {
    it('reads the gallery and one template', () => {
        const list = readTemplates({
            templates: [{ id: 't1', version: 2, title: 'Form', tags: ['a', 3], source: 'captured' }, { title: 'x' }],
        });
        expect(list).toEqual([
            { id: 't1', version: 2, title: 'Form', description: '', category: '', icon: null, tags: ['a'], source: 'captured' },
        ]);
        const one = readTemplate({ template: { id: 't1', definition: { screens: [] }, dataModel: { tables: [] } } });
        expect(one?.definition).toEqual({ screens: [] });
        expect(one?.dataModel).toEqual({ tables: [] });
        expect(one?.source).toBe('builtin');
        expect(readTemplate({ template: null })).toBeNull();
    });

    it('reads the catalog top level and keeps the specs open', () => {
        const catalog = readCatalog({
            schemaVersion: 2,
            acceptedSchemaVersions: [1, 2, 'x'],
            limits: { MAX_SCREENS: 30, junk: 'no' },
            components: { button: { props: {} } },
            events: ['onClick'],
        });
        expect(catalog.acceptedSchemaVersions).toEqual([1, 2]);
        expect(catalog.limits).toEqual({ MAX_SCREENS: 30 });
        expect(catalog.components.button).toEqual({ props: {} });
        expect(catalog.colorRoles).toEqual([]);
        expect(readCatalog(null).schemaVersion).toBe(2);
    });
});

describe('issues, check and versions', () => {
    it('reads an issue list and defaults an unknown severity to error', () => {
        expect(readIssues([{ code: 'meta.name_missing', severity: 'fatal', path: 'meta.name', message: 'm' }])).toEqual([
            { code: 'meta.name_missing', severity: 'error', path: 'meta.name', message: 'm', hint: null },
        ]);
    });

    it('reads the check result, renaming _hints', () => {
        const check = readCheck({
            ok: false,
            static: { errors: [{ code: 'x', severity: 'error', path: '', message: 'bad' }], warnings: [] },
            bindings: [{ ok: true }, 'junk'],
            emptyTables: ['orders'],
            _hints: ['seed data'],
        });
        expect(check.ok).toBe(false);
        expect(check.static.errors).toHaveLength(1);
        expect(check.bindings).toEqual([{ ok: true }]);
        expect(check.emptyTables).toEqual(['orders']);
        expect(check.hints).toEqual(['seed data']);
        expect(check.roleFindings).toEqual([]);
    });

    it('reads the version history', () => {
        expect(readVersions({ versions: [{ id: 'v1', appId: 'a', summary: 'Published', createdAt: null }, {}] })).toEqual([
            { id: 'v1', appId: 'a', summary: 'Published', createdAt: null },
        ]);
    });
});
