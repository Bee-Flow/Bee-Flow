/**
 * The file strip of the Code tab: which files does this page HAVE, and how
 * large are they?
 *
 * ── WHY THIS IS NOT THREE BOXES ─────────────────────────────────────
 *
 * The three slots are called `index.html`, `style.css` and `script.js`. That is a
 * deliberate deviation from the habit (`styles.css` / `app.js`), and those names
 * are fixed: the storage, the file explorer, the ZIP export and the snapshot
 * renderer all write them in exactly this way.
 *
 * But three slots are not the whole project, and for most pages not even the
 * main part:
 *
 *   - a REACT-MUI project (since `integrations/webpageFramework.js` the default
 *     for EVERY new page) writes its app as extra files under `src/`; the html is
 *     generated during rendering and the css and js slots stay empty. Drawing three
 *     boxes of which two stay empty tells the author something that is not true;
 *   - a VANILLA project may place `modules/state.js` or `about.html` next to the
 *     slots. Leaving those out is just as wrong, the other way round.
 *
 * Hence the rule below: a slot goes into the strip if it has content, or if the
 * project is vanilla (there the three slots ARE the project, an empty one too).
 * Every extra file always goes in, text or binary. And a file that only the
 * SERVER knows — the scan found marks in it, but the editor has not (yet) loaded
 * it — goes in as well, with an unknown size instead of silence.
 *
 * ── "0 B" IS A CLAIM ───────────────────────────────────────────────
 *
 * A file whose bytes we do not know gets `bytes: null`, not 0.
 * The strip says "size unknown" there; the total at the bottom says that it is
 * incomplete. Otherwise an unloaded file would read as an empty file.
 */

/** A mark as the server returns it; the strip only reads where it sits. */
export interface CodeMark {
    slot?: string;
    source?: string;
}

/** An extra file as the server describes it: `{ path, size, isText, mimeType }`. */
export interface CodeExtraFile {
    path: string;
    size?: number;
    isText?: boolean;
    mimeType?: string;
}

/** An extra file as the editor holds it: `{ isText, content }`. */
export interface CodeExtraContent {
    isText?: boolean;
    content?: string;
}

/** Eén bestand in de strip. */
export interface CodeFileEntry {
    key: string;
    name: string;
    kind: string;
    bytes: number | null;
    isText: boolean;
    loaded: boolean;
    marks: number;
    openable: boolean;
}

/** De strip, met het totaal eronder. */
export interface CodeFiles {
    files: CodeFileEntry[];
    totalBytes: number;
    bytesComplete: boolean;
}

interface BuildCodeFilesArgs {
    framework?: string;
    html?: string;
    css?: string;
    js?: string;
    extraFiles?: CodeExtraFile[] | null;
    extraContents?: Record<string, CodeExtraContent> | null;
    marks?: CodeMark[] | null;
}

/** De drie slots, met de namen die overal in het product gelden. */
export const PRIMARY_SLOTS = Object.freeze([
    Object.freeze({ slot: 'html', name: 'index.html' }),
    Object.freeze({ slot: 'css', name: 'style.css' }),
    Object.freeze({ slot: 'js', name: 'script.js' }),
]);

/** Dezelfde namen als kale lijst — voor wie alleen wil weten of iets gereserveerd is. */
export const PRIMARY_SLOT_NAMES = Object.freeze(PRIMARY_SLOTS.map(s => s.name));

/**
 * The Monaco language per slot. It belongs here, next to the slot names themselves.
 *
 * This table stood twice, character for character, in the same folder: in
 * WebpageIDE.jsx (the Code tab) and in WebpageHistoryTab.jsx (the read-only
 * "View"). Nothing linked them, so whoever changed the language of a slot — 'js'
 * to 'typescript' for JSX — got the same version coloured differently in two
 * screens.
 */
export const SLOT_LANGUAGE = Object.freeze({ html: 'html', css: 'css', js: 'javascript' });

/**
 * Bytes of a text in UTF-8, or `null` if we cannot know it.
 *
 * `String.length` counts UTF-16 units and would make an é or an emoji too small;
 * this is the same measure the server writes to disk.
 */
export function utf8Bytes(text: unknown): number | null {
    if (typeof text !== 'string') return null;
    try {
        return new TextEncoder().encode(text).length;
    } catch {
        // No TextEncoder → unknown, not "roughly". A wrong number is
        // worse than no number.
        return null;
    }
}

/** `1.2 KB` — of `null` als de grootte onbekend is. Nooit "0 B" bij twijfel. */
export function formatBytes(bytes: unknown): string | null {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The editor key of a mark: the same address as a tab.
 *
 * On `slot` and not on the file name, because otherwise the client would keep a
 * second list of names next to the server's.
 */
export function markFileKey(mark?: CodeMark | null): string | null {
    if (!mark) return null;
    if (mark.slot === 'html' || mark.slot === 'css' || mark.slot === 'js') return mark.slot;
    if (typeof mark.source === 'string' && mark.source) return `extra:${mark.source}`;
    return null;
}

/** Markeringen gegroepeerd op editor-sleutel, in de volgorde waarin ze binnenkwamen. */
export function marksByFile(marks?: CodeMark[] | null): Map<string, CodeMark[]> {
    const out = new Map<string, CodeMark[]>();
    for (const mark of (Array.isArray(marks) ? marks : [])) {
        const key = markFileKey(mark);
        if (!key) continue;
        if (!out.has(key)) out.set(key, []);
        (out.get(key) as CodeMark[]).push(mark);
    }
    return out;
}

/** Wat de strip van één extra bestand kan weten. */
function extraEntry(meta: CodeExtraFile, extraContents: Record<string, CodeExtraContent> | null | undefined, marks: CodeMark[]): CodeFileEntry {
    const path = String(meta.path);
    const content = extraContents ? extraContents[path] : null;
    const live = content && content.isText ? utf8Bytes(content.content || '') : null;
    const stored = typeof meta.size === 'number' && Number.isFinite(meta.size) && meta.size >= 0
        ? meta.size
        : null;
    return {
        key: `extra:${path}`,
        name: path,
        kind: 'extra',
        // De geladen inhoud wint van de opgeslagen grootte: dat is wat de
        // auteur in de editor ziet staan.
        bytes: live !== null ? live : stored,
        isText: meta.isText !== false,
        loaded: !!content,
        marks: marks.length,
        openable: true,
    };
}

/**
 * The slots this page really has.
 *
 * An empty slot of a react-mui project is not a file: the html is generated, css
 * and js are not used. For vanilla the three slots ARE the project, an empty one
 * too — there an empty `script.js` belongs in view.
 */
function slotEntries({ framework, text, byFile }: {
    framework: string;
    text: { html: string; css: string; js: string };
    byFile: Map<string, CodeMark[]>;
}): CodeFileEntry[] {
    const out: CodeFileEntry[] = [];
    for (const { slot, name } of PRIMARY_SLOTS) {
        const value = typeof text[slot] === 'string' ? text[slot] : '';
        if (!value && framework === 'react-mui') continue;
        out.push({
            key: slot,
            name,
            kind: 'slot',
            bytes: utf8Bytes(value),
            isText: true,
            loaded: true,
            marks: (byFile.get(slot) || []).length,
            openable: true,
        });
    }
    return out;
}

/** Elk extra bestand, tekst én binair: verzwijgen is hier de fout. */
function extraEntries(
    extraFiles: CodeExtraFile[] | null | undefined,
    extraContents: Record<string, CodeExtraContent> | null | undefined,
    byFile: Map<string, CodeMark[]>,
    seen: Set<string>,
): CodeFileEntry[] {
    const out: CodeFileEntry[] = [];
    for (const meta of (Array.isArray(extraFiles) ? extraFiles : [])) {
        if (!meta || !meta.path) continue;
        const entry = extraEntry(meta, extraContents, byFile.get(`extra:${meta.path}`) || []);
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        out.push(entry);
    }
    return out;
}

/**
 * Files that the scan DID see and the editor does not have — for example one
 * that the AI has just created. They belong in the strip: a mark in a file that
 * does not seem to exist is exactly the silence this tab must avoid.
 */
function serverOnlyEntries(byFile: Map<string, CodeMark[]>, seen: Set<string>): CodeFileEntry[] {
    const out: CodeFileEntry[] = [];
    for (const [key, group] of byFile) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            key,
            name: key.startsWith('extra:') ? key.slice(6) : key,
            kind: 'extra',
            bytes: null,
            isText: true,
            loaded: false,
            marks: group.length,
            openable: false,
        });
    }
    return out;
}

/**
 * The strip.
 *
 * `framework` is 'vanilla' | 'react-mui' | …; `extraContents` goes from path to
 * the content as the editor holds it; `marks` comes from GET /:id/bindings.
 */
export function buildCodeFiles({
    framework = 'vanilla',
    html = '', css = '', js = '',
    extraFiles = [],
    extraContents = {},
    marks = [],
} : BuildCodeFilesArgs = {}): CodeFiles {
    const byFile = marksByFile(marks);
    const files = slotEntries({ framework, text: { html, css, js }, byFile });

    const seen = new Set(files.map((f: CodeFileEntry) => f.key));
    for (const entry of extraEntries(extraFiles, extraContents, byFile, seen)) files.push(entry);
    for (const entry of serverOnlyEntries(byFile, seen)) files.push(entry);

    const known = files.filter((f: CodeFileEntry): f is CodeFileEntry & { bytes: number } => typeof f.bytes === 'number');
    return {
        files,
        totalBytes: known.reduce((sum: number, f) => sum + f.bytes, 0),
        bytesComplete: known.length === files.length,
    };
}

export default buildCodeFiles;
