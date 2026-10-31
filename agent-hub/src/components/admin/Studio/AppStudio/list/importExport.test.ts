// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { filePreview, humanBytes, importMetaLine, importProvenanceText } from './importExport';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The English fallback with its {placeholders} filled, as useTranslation renders it. */
const t: TranslateFn = (_key, fallback, params) => String(fallback ?? '')
    .replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? `{${k}}`));

const TEMPLATE_FILE = {
    format: 'beeflow.apptemplate',
    source: { orgName: 'Acme BV' },
    template: {
        title: 'Purchase intake',
        description: 'From a colleague.',
        definition: { screens: [{ id: 'scr_1' }, { id: 'scr_2' }] },
        dataModel: { tables: [{ id: 'tbl_a' }] },
        seed: { tbl_a: [{ name: 'Ada' }, { name: 'Grace' }] },
    },
};

const ARCHIVE_FILE = {
    format: 'beeflow.app',
    app: { name: 'Aanvraag automatisering', description: 'With its data' },
    template: { definition: { screens: [{ id: 'scr_1' }, { id: 'scr_2' }] }, dataModel: { tables: [{ id: 'tbl_a' }] } },
    content: {
        records: { tbl_a: [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Alan' }] },
        files: [{ ref: 'f1', size: 2 * 1024 * 1024 }, { ref: 'f2', size: 1024 }],
    },
};

describe('filePreview — what a picked file says about itself', () => {
    it('reads nothing off something that is not an object', () => {
        expect(filePreview(null, t)).toBeNull();
        expect(filePreview('text', t)).toBeNull();
    });

    it('reads a template file as a blueprint with example rows and no files', () => {
        expect(filePreview(TEMPLATE_FILE, t)).toEqual({
            kind: 'template',
            title: 'Purchase intake',
            description: 'From a colleague.',
            orgName: 'Acme BV',
            tables: 1,
            screens: 2,
            rows: 2,
            files: 0,
            bytes: 0,
        });
    });

    it('reads an app archive as real rows and real files, named after the app', () => {
        expect(filePreview(ARCHIVE_FILE, t)).toMatchObject({
            kind: 'app',
            title: 'Aanvraag automatisering',
            orgName: null,
            rows: 3,
            files: 2,
            bytes: 2 * 1024 * 1024 + 1024,
        });
    });

    it('falls back to an untitled name when the file carries none', () => {
        expect(filePreview({ template: {} }, t)?.title).toBe('Untitled template');
        expect(filePreview({ format: 'beeflow.app' }, t)?.title).toBe('Untitled app');
    });
});

describe('the import preview text', () => {
    it('counts screens, tables, rows and files, then names the file', () => {
        const tpl = filePreview(TEMPLATE_FILE, t)!;
        expect(importMetaLine(tpl, { name: 'demo.json' }, t)).toBe('2 screens · 1 table · 2 example rows · demo.json');
        const app = filePreview(ARCHIVE_FILE, t)!;
        expect(importMetaLine(app, null, t)).toBe('2 screens · 1 table · 3 rows · 2 files (2.0 MB)');
    });

    it('writes bytes as something a person reads at a glance', () => {
        expect(humanBytes(0)).toBeNull();
        expect(humanBytes(10)).toBe('1 kB');
        expect(humanBytes(2048)).toBe('2 kB');
        expect(humanBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    });

    it('words provenance as a claim the file makes', () => {
        expect(importProvenanceText(filePreview(TEMPLATE_FILE, t)!, t)).toMatch(/^The file says it came from Acme BV/);
        expect(importProvenanceText(filePreview(ARCHIVE_FILE, t)!, t)).toMatch(/an app archive brings real rows/);
    });
});
