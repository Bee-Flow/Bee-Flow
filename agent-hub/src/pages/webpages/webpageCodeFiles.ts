/**
 * De bestandenstrip van de Code-tab: welke bestanden HEEFT deze pagina, en hoe
 * groot zijn ze?
 *
 * ── WAAROM DIT GEEN DRIE VAKJES IS ──────────────────────────────────
 *
 * De drie slots heten `index.html`, `style.css` en `script.js`. Dat is een
 * bewuste afwijking van de gewoonte (`styles.css` / `app.js`) en die namen
 * liggen vast: de opslag, de bestandsverkenner, de ZIP-export en de
 * snapshot-renderer schrijven ze alle vier zo op.
 *
 * Maar drie slots zijn niet het hele project, en voor de meeste pagina's niet
 * eens de hoofdmoot:
 *
 *   - een REACT-MUI-project (sinds `integrations/webpageFramework.js` de
 *     standaard voor élke nieuwe pagina) schrijft zijn app als extra bestanden
 *     onder `src/`; de html wordt bij het renderen gegenereerd en het css- en
 *     js-slot blijven leeg. Drie vakjes tekenen waarvan er twee leeg blijven,
 *     vertelt de auteur iets dat niet waar is;
 *   - een VANILLA-project mag `modules/state.js` of `about.html` naast de
 *     slots zetten. Die verzwijgen is net zo fout de andere kant op.
 *
 * Vandaar de regel hieronder: een slot komt in de strip als het inhoud heeft,
 * of als het project vanilla is (daar ZIJN de drie slots het project, ook een
 * lege). Elk extra bestand komt er altijd in, tekst of binair. En een bestand
 * dat alleen de SERVER kent — de scan vond er markeringen in, maar de editor
 * heeft het (nog) niet geladen — komt er ook in, met een onbekende grootte in
 * plaats van stilte.
 *
 * ── "0 B" IS EEN BEWERING ───────────────────────────────────────────
 *
 * Een bestand waarvan we de bytes niet kennen krijgt `bytes: null`, niet 0.
 * De strip zegt daar "size unknown"; het totaal onderaan zegt erbij dat het
 * onvolledig is. Anders leest een niet-geladen bestand als een leeg bestand.
 */

/** Een markering zoals de server hem teruggeeft; de strip leest alleen waar hij staat. */
export interface CodeMark {
    slot?: string;
    source?: string;
}

/** Een extra bestand zoals de server het beschrijft: `{ path, size, isText, mimeType }`. */
export interface CodeExtraFile {
    path: string;
    size?: number;
    isText?: boolean;
    mimeType?: string;
}

/** Een extra bestand zoals de editor het houdt: `{ isText, content }`. */
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
 * De Monaco-taal per slot. Hoort hier, bij de slotnamen zelf.
 *
 * Deze tabel stond teken-voor-teken twee keer in dezelfde map: in
 * WebpageIDE.jsx (de Code-tab) en in WebpageHistoryTab.jsx (het alleen-lezen
 * "Bekijk"). Niets verbond ze, dus wie de taal van een slot veranderde — 'js'
 * naar 'typescript' voor JSX — kreeg dezelfde versie in twee schermen anders
 * gekleurd.
 */
export const SLOT_LANGUAGE = Object.freeze({ html: 'html', css: 'css', js: 'javascript' });

/**
 * Bytes van een tekst in UTF-8, of `null` als we het niet kunnen weten.
 *
 * `String.length` telt UTF-16-eenheden en zou een é of een emoji te klein
 * maken; dit is dezelfde maat als de server op schijf zet.
 */
export function utf8Bytes(text: unknown): number | null {
    if (typeof text !== 'string') return null;
    try {
        return new TextEncoder().encode(text).length;
    } catch {
        // Geen TextEncoder → onbekend, niet "ongeveer". Een fout getal is
        // erger dan geen getal.
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
 * De editor-sleutel van een markering: hetzelfde adres als een tab.
 *
 * Op `slot` en niet op de bestandsnaam, want dan zou de client een tweede
 * naamlijst bijhouden naast die van de server.
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
 * De slots die deze pagina echt heeft.
 *
 * Een leeg slot van een react-mui-project is geen bestand: de html wordt
 * gegenereerd, css en js worden niet gebruikt. Bij vanilla ZIJN de drie slots
 * het project, ook een lege — daar hoort een leeg `script.js` gewoon in beeld.
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
 * Bestanden die de scan wél zag en de editor niet heeft — bijvoorbeeld eentje
 * dat de AI zojuist heeft aangemaakt. Ze horen in de strip: een markering in
 * een bestand dat er niet lijkt te zijn, is precies de stilte die deze tab
 * moet vermijden.
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
 * De strip.
 *
 * `framework` is 'vanilla' | 'react-mui' | …; `extraContents` gaat van pad naar
 * de inhoud zoals de editor het houdt; `marks` komt uit GET /:id/bindings.
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
