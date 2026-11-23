/**
 * The document as it stands while it is being filled in: its body with the
 * values that are there, and each value that is still NEEDED printed as its
 * label in brackets ("[Client name]"), so a person sees where a field ends up
 * and what is still open. The fill-in form shows it next to the fields
 * (GET /api/studio-documents/:id/values/preview).
 *
 * Apart from those labels it is the document the download makes: an empty
 * field the template has a default for prints that default, and an empty
 * optional field prints nothing. With nothing needed left, the picture and the
 * download say the same.
 *
 * It is a picture for the person filling in, never a file: the download keeps
 * refusing a document with a required value missing. The labels are the ones a
 * template's own download prints (core/documents/templatePlaceholders.mts): a
 * yes/no value and a value only a section rule reads stay missing, because a
 * label there would decide what the document says.
 *
 * Composed as the editor's own sheet is (services/documentCompose.js, mode
 * 'preview'): sanitised, with the organisation's house style, and with the
 * frame's bridge, whose only use here is keeping the reader's place when the
 * picture is drawn again. Nothing ever asks this frame for its content back.
 */

import { createRequire } from 'node:module';
import { templatePreviewValues } from './templatePlaceholders.mts';
import { isObject, valuesOf, type Settings, type TemplateDoc } from './templateValues.mts';

const nodeRequire = createRequire(import.meta.url);

type Fill = { bodyHtml: string, issues?: Array<{ code: string, key?: string }> };
export type FillPreviewDeps = {
    prepare: (doc: TemplateDoc, values: Settings, overrides: Settings) => Fill,
    setPath: (target: Settings, key: string, value: unknown) => void,
    compose: (doc: TemplateDoc, options: { mode: 'preview', houseStyleCss: string }) => string,
    houseStyleCss: (doc: TemplateDoc, orgId: string | null) => Promise<string>,
};
export type FillPreview = {
    /** A complete HTML document, for a sandboxed frame. */
    html: string,
    /** The keys of the fields that are still needed and shown as their label in brackets. */
    gaps: string[],
};

const refusal = (message: string, status: number, errorClass: string): Error => Object.assign(new Error(message), { status, errorClass });

function realDeps(): FillPreviewDeps {
    const { featureModule } = nodeRequire('../featureModules.js') as { featureModule: (name: string) => unknown };
    return {
        prepare: (doc, values, overrides) => nodeRequire('./documentContract').prepareDocument(doc, values, overrides),
        setPath: (target, key, value) => nodeRequire('./documentContract').setPath(target, key, value),
        compose: (doc, options) => (featureModule('services/documentCompose') as { composeDocument: FillPreviewDeps['compose'] })
            .composeDocument(nodeRequire('./pageDocument').forCompose(doc), options),
        houseStyleCss: (doc, orgId) => nodeRequire('./renderFilledDocument').houseStyleCssFor(doc, orgId),
    };
}

/** The value at a dotted key. */
function valueAt(values: Settings, key: string): unknown {
    let at: unknown = values;
    for (const part of key.split('.')) at = isObject(at) ? at[part] : undefined;
    return at;
}

/** The keys a fill reports as required and missing. */
function neededKeys(fill: Fill): Set<string> {
    const keys = new Set<string>();
    for (const issue of fill.issues || []) if (issue.code === 'required' && issue.key) keys.add(String(issue.key));
    return keys;
}

/** The picture of `doc` with its values filled in. A presentation has its own viewer and is refused. */
export async function filledPreview(doc: TemplateDoc, orgId: string | null, deps: FillPreviewDeps = realDeps()): Promise<FillPreview> {
    if (doc.docType === 'presentation') {
        throw refusal('A presentation is previewed in its own slide viewer.', 422, 'fill_preview_unsupported');
    }
    const stored = valuesOf(doc);
    const overrides = isObject(doc.settings?.sectionOverrides) ? doc.settings.sectionOverrides : {};
    // What the download would refuse on: only those get a label. The rest prints as the download prints it.
    const needed = neededKeys(deps.prepare(doc, stored, overrides));
    const labelled = templatePreviewValues(doc, stored);
    const gaps = labelled.filled.filter((key) => needed.has(key));
    const values = structuredClone(stored);
    for (const key of gaps) deps.setPath(values, key, valueAt(labelled.values, key));
    const fill = deps.prepare(doc, values, overrides);
    const html = deps.compose({ ...doc, bodyHtml: fill.bodyHtml }, { mode: 'preview', houseStyleCss: await deps.houseStyleCss(doc, orgId) });
    return { html, gaps };
}
