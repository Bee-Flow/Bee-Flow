import type { FilePreview } from './types';
import type { TranslateFn } from '@/hooks/useTranslation';

// ── Template / app files: saving one, and reading what one claims ───

/** A picked file as far as the preview reads it: every field may be absent or wrong. */
interface EnvelopeTemplate {
    title?: unknown;
    description?: unknown;
    seed?: unknown;
    dataModel?: { tables?: unknown };
    definition?: { screens?: unknown };
}

interface Envelope {
    format?: unknown;
    template?: EnvelopeTemplate;
    app?: { name?: unknown; description?: unknown };
    source?: { orgName?: unknown };
    content?: { records?: unknown; files?: unknown };
}

type PreviewCommon = Pick<FilePreview, 'orgName' | 'tables' | 'screens'>;

/**
 * Hand the browser a file to save.
 *
 * A blob URL and a real anchor, revoked on the next tick. An `<a href="#"
 * download>` does nothing at all in a SPA — the automations library learned that
 * one the slow way — and a data: URL breaks on anything of size.
 */
function saveJsonFile(filename: string, data: unknown): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * What the file SAYS about itself, and nothing more.
 *
 * Deliberately not a validation: the server re-decides every one of these
 * questions when the file is posted (templatePortability.sanitizeImport /
 * appPortability.sanitizeAppImport), and a second opinion here would be a
 * second implementation to keep in step — the one that is wrong being,
 * inevitably, the one people read. So this reads the envelope's own claims,
 * says they are claims, and leaves the verdict to the import itself.
 *
 * TWO FILE KINDS, ONE PICKER. A template file (`beeflow.apptemplate`) carries a
 * blueprint and lands in the gallery; an app archive (`beeflow.app`) carries a
 * particular app with its rows and its documents and lands as a working app.
 * Asking somebody to pick the right slot first would be asking them to know
 * which kind they were sent — the file already says, so `kind` is read off it
 * and everything downstream follows.
 */
function previewStr(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Rows across every table/list in a seed or records bag, however it names them. */
function previewRowCount(bag: unknown): number {
    return bag && typeof bag === 'object'
        ? Object.values(bag).reduce((n: number, list: unknown) => n + (Array.isArray(list) ? list.length : 0), 0)
        : 0;
}

/** An app archive: real rows and real files, already installed content. */
function appFilePreview(envelope: Envelope, tpl: EnvelopeTemplate, common: PreviewCommon, t: TranslateFn): FilePreview {
    const content = (envelope.content && typeof envelope.content === 'object') ? envelope.content : {};
    const files = Array.isArray(content.files) ? content.files : [];
    const bytes = files.reduce((n: number, f: { size?: unknown } | null) => n + (Number(f?.size) || 0), 0);
    return {
        kind: 'app',
        title: previewStr(envelope.app?.name, 120) || previewStr(tpl.title, 80) || t('studio_apps_bi.list.untitled_app', 'Untitled app'),
        description: previewStr(envelope.app?.description, 400) || '',
        ...common,
        rows: previewRowCount(content.records),
        files: files.length,
        bytes,
    };
}

/** A template: a blueprint plus its example seed rows, no files. */
function templateFilePreview(tpl: EnvelopeTemplate, common: PreviewCommon, t: TranslateFn): FilePreview {
    return {
        kind: 'template',
        title: previewStr(tpl.title, 80) || t('studio_apps_bi.list.untitled_template', 'Untitled template'),
        description: previewStr(tpl.description, 400) || '',
        ...common,
        rows: previewRowCount(tpl.seed),
        files: 0,
        bytes: 0,
    };
}

function filePreview(envelope: unknown, t: TranslateFn): FilePreview | null {
    if (!envelope || typeof envelope !== 'object') return null;
    const env = envelope as Envelope;
    const tpl: EnvelopeTemplate = (env.template && typeof env.template === 'object') ? env.template : {};
    const common: PreviewCommon = {
        orgName: previewStr(env.source?.orgName, 200),
        tables: (tpl.dataModel && Array.isArray(tpl.dataModel.tables)) ? tpl.dataModel.tables.length : 0,
        screens: Array.isArray(tpl.definition?.screens) ? tpl.definition.screens.length : 0,
    };
    return env.format === 'beeflow.app'
        ? appFilePreview(env, tpl, common, t)
        : templateFilePreview(tpl, common, t);
}

/** Bytes as something a person reads at a glance. */
function humanBytes(n: number): string | null {
    if (!n) return null;
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} kB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "2 screens · 1 table · 3 rows · 2 files (2.0 MB) · demo.json" */
function importMetaLine(preview: FilePreview, file: { name?: string } | null | undefined, t: TranslateFn): string {
    let line = preview.screens === 1
        ? t('app_studio.list.import_screen_one', '1 screen')
        : t('app_studio.list.import_screen_many', '{n} screens', { n: preview.screens });
    if (preview.tables) {
        line += ` · ${preview.tables === 1
            ? t('studio_apps_bi.list.import_table_one', '1 table')
            : t('studio_apps_bi.list.import_table_many', '{n} tables', { n: preview.tables })}`;
    }
    if (preview.rows) {
        const one = preview.kind === 'app'
            ? t('studio_apps_bi.list.import_row_one', '1 row')
            : t('studio_apps_bi.list.import_example_row_one', '1 example row');
        const many = preview.kind === 'app'
            ? t('studio_apps_bi.list.import_row_many', '{n} rows', { n: preview.rows })
            : t('studio_apps_bi.list.import_example_row_many', '{n} example rows', { n: preview.rows });
        line += ` · ${preview.rows === 1 ? one : many}`;
    }
    if (preview.files) {
        line += ` · ${preview.files === 1
            ? t('studio_apps_bi.list.import_file_one', '1 file')
            : t('studio_apps_bi.list.import_file_many', '{n} files', { n: preview.files })}`;
    }
    if (preview.bytes) line += ` (${humanBytes(preview.bytes)})`;
    if (file?.name) line += ` · ${file.name}`;
    return line;
}

/** The provenance block is a claim the file makes, so it is worded as one.
 *  It grants nothing and the server ignores it. */
function importProvenanceText(preview: FilePreview, t: TranslateFn): string {
    if (preview.orgName) {
        return t('studio_apps_bi.list.import_provenance_org', 'The file says it came from {org}. That is what it says — check the file comes from someone you trust.', { org: preview.orgName });
    }
    return preview.kind === 'app'
        ? t('studio_apps_bi.list.import_provenance_app', 'Check the file comes from someone you trust: an app archive brings real rows and real documents with it.')
        : t('studio_apps_bi.list.import_provenance_template', 'Check the file comes from someone you trust: a template brings screens, tables and example rows with it.');
}

export { saveJsonFile, filePreview, humanBytes, importMetaLine, importProvenanceText };
