import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { BF_FAMILIES, buildBfDecorations, familyClass, familyOf, publishedFate, survivesPublishing, type BfMarkGroup, type BfMark } from './bfDecorations';
import { buildCodeFiles, formatBytes, markFileKey, type CodeMark, type CodeFileEntry, type CodeExtraFile } from './webpageCodeFiles';
import useTranslation from '../../hooks/useTranslation';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { ExtraContents } from '../../api/webpageEditorTypes';
import type { FileKey } from './ide/ideFiles';

/**
 * The strip above the editor in the Code tab: which files does this page have, how large are they, and what do the markers in the code mean?
 *
 * ── TWO THINGS THIS SCREEN MAY NOT CLAIM ─────────────────────────────
 *
 * 1. "THIS PAGE HAS THREE FILES." That is the exception, not the rule: a react-mui project has its app in `src/`, and a vanilla project may place files beside the slots. `webpageCodeFiles.js` therefore builds the list from what IS there — including a file that only the server knows about.
 *
 * 2. "THERE ARE NO BINDINGS." If the markers could not be computed — the call failed, or the server could not read the files — then the legend says THAT, instead of staying silent. A page without markers may not look like a page without bindings; that is the whole reason this legend exists.
 *
 * ── ONE READING, TWO USERS ───────────────────────────────────────────
 *
 * `useBfMarks` (useBfMarks.ts) fetches the markers from `GET /api/webpages/:id/bindings` — the same parser as the rest of W4 (`core/webpages/webpageBindings.js`), which takes the vocabulary from `core/webpages/bfElements.js`. The IDE passes that result to two sides: to this strip (the legend) and to Monaco (the decorations). One reading, so the legend cannot claim anything other than what the editor draws.
 *
 * ── THE MARKERS COME FROM THE SAVED COPY ────────────────────────────
 *
 * The server reads what is in storage; the editor shows what is on screen. As long as nothing is unsaved, those are the same; after that the line numbers shift. The strip says so then (`legend_stale`), and the IDE fetches the markers again as soon as there is a save.
 */

/** Een markering zoals de server hem teruggeeft: waar hij staat en waar hij aan hangt. */
export type StripMark = CodeMark & BfMark & { targetId?: string; dynamic?: boolean; fallback?: boolean };

/** De uitslag van `useBfMarks`. */
export interface MarksState {
    marks: StripMark[];
    loading: boolean;
    available: boolean;
    reload?: () => void;
    truncated?: number;
}

/** Hoeveel bestanden de strip hoogstens uitschrijft voordat hij gaat tellen. */
const MAX_CHIPS = 24;

/** De naam van een familie, zoals de auteur ze in Studio kent. */
export function familyLabel(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, family: string) {
    switch (family) {
        case 'datatable': return t('webpages.code.family_datatable', 'Data table');
        case 'automation': return t('webpages.code.family_automation', 'Automation');
        case 'agent': return t('webpages.code.family_agent', 'Agent');
        case 'incomplete': return t('webpages.code.family_incomplete', 'Not linked yet');
        case 'unknown': return t('webpages.code.family_unknown', 'Not recognised');
        // A family that adds the vocabulary later: the bare key is preferable to nothing,
        // so that it stands out instead of disappearing.
        default: return family;
    }
}

/**
 * Where this marker hangs, in one piece of text.
 *
 * `dynamic` is deliberately an answer of its own: the author HAS written down an address, but the page builds it while it runs. Showing that as "not linked" would send him looking for a fault that does not exist.
 */
function targetText(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, mark: StripMark) {
    if (mark.targetId) return mark.targetId;
    if (mark.dynamic) return t('webpages.code.dynamic_target', 'worked out while the page runs');
    if (Array.isArray(mark.missing) && mark.missing.length) return null;
    if (mark.fallback) return t('webpages.code.page_agent', "this page's own link");
    return null;
}

/** Het label achter de regel in de editor. */
function decorationLabel(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, group: BfMarkGroup) {
    const tags = [...new Set(group.marks.map(m => m.tag))].join(', ');
    const first = group.marks[0];
    if (group.marks.length > 1) return `${tags} · ${familyLabel(t, group.family)}`;
    const target = targetText(t, first);
    if (target) return `${tags} → ${target}`;
    return `${tags} · ${familyLabel(t, group.family)}`;
}

/** De tooltip: hetzelfde, plus wat er ontbreekt. */
function decorationHover(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, group: BfMarkGroup) {
    const lines = group.marks.map((mark) => {
        const target = targetText(t, mark);
        const head = target
            ? `\`${mark.tag}\` → ${target}`
            : `\`${mark.tag}\` · ${familyLabel(t, familyOf(mark))}`;
        if (Array.isArray(mark.missing) && mark.missing.length) {
            return `${head} — ${t('webpages.code.needs_attribute', 'needs {attr}', { attr: mark.missing.join(', ') })}`;
        }
        // WHAT HAPPENS ONCE THE PAGE IS PUBLISHED. The sentence comes from the mirrored
        // registry, so it is exactly the same as what the reader sees at /w/<slug>.
        // Without this, a button that is dead there would read like an equal binding.
        const fate = publishedFate(mark.tag);
        if (fate && !survivesPublishing(mark.tag) && fate.notice) {
            return `${head}\n\n${t('webpages.code.published_fate', 'Once published: {notice}', { notice: fate.notice })}`;
        }
        return head;
    });
    return lines.join('\n\n');
}

/**
 * The Monaco decorations for ONE file.
 *
 * This is where the two halves come together: `bfDecorations.js` knows what a decoration looks like, `t` knows how the text reads. The IDE calls this; the editor receives ready-made data and needs to know nothing about `bf-*`.
 */
interface FileDecorationsArgs {
    marks: (StripMark | null)[];
    fileKey: string | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export function fileDecorations({ marks, fileKey, t }: FileDecorationsArgs) {
    if (!fileKey) return [];
    const mine = (Array.isArray(marks) ? marks : []).filter(m => markFileKey(m) === fileKey);
    return buildBfDecorations(mine as BfMark[], {
        label: (group) => decorationLabel(t, group),
        hover: (group) => decorationHover(t, group),
    });
}

/** Eén bestand in de strip. */
interface FileChipProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    file: CodeFileEntry;
    active: boolean;
    dirty: boolean;
    onOpen?: (key: FileKey) => void;
}

function FileChip({ t, file, active, dirty, onOpen }: FileChipProps) {
    const size = formatBytes(file.bytes);
    const label = size || t('webpages.code.size_unknown', 'size unknown');
    const Tag = file.openable ? 'button' : 'span';
    return (
        <Tag
            {...(file.openable
                ? { type: 'button', onClick: () => onOpen?.(file.key), 'aria-pressed': !!active }
                : { title: t('webpages.code.not_loaded', 'This file has not been loaded in the editor.') })}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] whitespace-nowrap"
            style={{
                background: active ? 'var(--vsc-file-active-bg)' : 'var(--vsc-hover-bg)',
                color: active ? 'var(--vsc-fg)' : 'var(--vsc-fg-muted)',
                border: '1px solid var(--vsc-border)',
                cursor: file.openable ? 'pointer' : 'default',
                opacity: file.loaded ? 1 : 0.7,
            }}
        >
            <span className="font-mono">{file.name}</span>
            <span className="[opacity:0.75]">{label}</span>
            {dirty && (
                <span
                    className="w-1.5 h-1.5 rounded-full bg-[var(--vsc-fg-muted)]"
                    title={t('webpages.code.unsaved', 'Unsaved changes')}
                />
            )}
            {file.marks > 0 && (
                <span
                    className="px-1 rounded bg-[var(--vsc-border)] text-[var(--vsc-fg)]"
                    title={t('webpages.code.marks_in_file', '{count} highlighted lines', { count: file.marks })}
                >
                    {file.marks}
                </span>
            )}
        </Tag>
    );
}

/**
 * How many files, and how large together.
 *
 * If a file is included whose bytes we do not know, the total is a LOWER bound and says so. A sum that silently skips a file is a wrong number, and that is worse than a vague number.
 */
interface TotalsProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    count: number;
    totalBytes: number;
    complete: boolean;
}

function Totals({ t, count, totalBytes, complete }: TotalsProps) {
    const total = formatBytes(totalBytes);
    return (
        <span className="text-[11px] ml-auto text-[var(--vsc-fg-muted)]">
            {t(count === 1 ? 'webpages.code.files_count' : 'webpages.code.files_count_plural',
                count === 1 ? '{count} file' : '{count} files', { count })}
            {total ? ' · ' : ''}
            {total && (complete ? total : t('webpages.code.total_at_least', 'at least {size}', { size: total }))}
        </span>
    );
}

/** The legend: what the shades mean — or why there are none. */
interface LegendProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    marksState: MarksState;
    readOnly: boolean;
    stale: boolean;
}

function Legend({ t, marksState, readOnly, stale }: LegendProps) {
    const perFamily = useMemo(() => {
        const counts = new Map<string, number>();
        for (const mark of marksState.marks) {
            const family = familyOf(mark);
            counts.set(family, (counts.get(family) || 0) + 1);
        }
        // Vaste volgorde: het vocabulaire eerst, de twee uitzonderingen erachter.
        return BF_FAMILIES.filter(f => counts.has(f)).map(f => ({ family: f, count: counts.get(f) }));
    }, [marksState.marks]);

    // How many of these bindings publishing will NOT survive. Three of the five
    // elements are inert on a published page (no JS runs there), and this screen is
    // the only one that shows the bindings — so it must show this too.
    const inertOnPublish = useMemo(
        () => marksState.marks.filter(m => m.known !== false && !survivesPublishing(m.tag)).length,
        [marksState.marks],
    );

    if (readOnly) {
        return (
            <span className="text-[var(--vsc-fg-muted)]">
                {t('webpages.code.legend_owner_only', 'Only the page owner can see which lines link to Studio.')}
            </span>
        );
    }

    if (marksState.loading) {
        return (
            <span className="flex items-center gap-1.5 text-[var(--vsc-fg-muted)]">
                <Loader2 size={11} className="animate-spin" />
                {t('webpages.code.legend_loading', 'Working out the Studio links…')}
            </span>
        );
    }

    // The state this legend exists to show: nothing has been computed, so the
    // ABSENCE of markers says nothing about the page.
    if (!marksState.available) {
        return (
            <span className="flex items-center gap-1.5 flex-wrap [color:var(--warning-ink,#8a5a00)]">
                <AlertTriangle size={11} />
                {t('webpages.code.legend_unavailable',
                    'The Studio links in this code could not be worked out, so nothing is highlighted. This page may still have links.')}
                <button
                    type="button"
                    onClick={marksState.reload}
                    className="underline inline-flex items-center gap-1 [color:inherit]"
                >
                    <RefreshCw size={10} /> {t('webpages.retry', 'Try again')}
                </button>
            </span>
        );
    }

    if (!perFamily.length) {
        return (
            <span className="text-[var(--vsc-fg-muted)]">
                {t('webpages.code.legend_none', 'Nothing in this code links to Studio yet.')}
            </span>
        );
    }

    return (
        <span className="flex items-center gap-2 flex-wrap text-[var(--vsc-fg-muted)]">
            <span>{t('webpages.code.legend', 'Highlighted = Studio link')}</span>
            {perFamily.map(({ family, count }) => (
                <span key={family} className="flex items-center gap-1">
                    <span className={`bf-legend-swatch ${familyClass(family)}`} aria-hidden="true" />
                    {familyLabel(t, family)} · {count}
                </span>
            ))}
            {inertOnPublish > 0 && (
                <span data-testid="legend-inert-on-publish">
                    {t('webpages.code.legend_inert_on_publish',
                        '{count} of these stop working once the page is published.', { count: inertOnPublish })}
                </span>
            )}
            {Number(marksState.truncated) > 0 && (
                <span>
                    {t('webpages.code.legend_truncated', '{count} more are not highlighted.',
                        { count: marksState.truncated })}
                </span>
            )}
            {stale && (
                <span>
                    {t('webpages.code.legend_stale', 'Highlighting is from the last saved version.')}
                </span>
            )}
        </span>
    );
}

/**
 * @param {object} props
 * @param {string} [props.framework]      'vanilla' | 'react-mui' | …
 * @param {string} [props.html]
 * @param {string} [props.css]
 * @param {string} [props.js]
 * @param {Array<import('./webpageEditorTypes').ExtraFileMeta>} [props.extraFiles]
 * @param {import('./webpageEditorTypes').ExtraContents} [props.extraContents]
 * @param {object} props.marksState       the result of `useBfMarks`
 * @param {string | null} [props.activeKey]  the file the editor shows
 * @param {function} [props.onOpen]       (key) => void — open this file
 * @param {object} [props.dirtyFiles]     editor key → unsaved?
 * @param {boolean} [props.readOnly]      not the owner: /bindings is owner-only
 */
interface WebpageCodeStripProps {
    framework?: string | undefined;
    html?: string;
    css?: string;
    js?: string;
    extraFiles?: CodeExtraFile[];
    extraContents?: ExtraContents;
    marksState?: MarksState;
    activeKey?: string | null;
    onOpen: (key: FileKey) => void;
    dirtyFiles?: Record<string, boolean>;
    readOnly?: boolean;
}

export default function WebpageCodeStrip({
    framework = 'vanilla',
    html = '', css = '', js = '',
    extraFiles = [],
    extraContents = {},
    marksState,
    activeKey = null,
    onOpen,
    dirtyFiles = {},
    readOnly = false,
}: WebpageCodeStripProps) {
    const { t } = useTranslation();
    const allMarks = marksState?.marks;

    const { files, totalBytes, bytesComplete } = useMemo(() => buildCodeFiles({
        framework, html, css, js, extraFiles, extraContents, marks: allMarks || [],
    }), [framework, html, css, js, extraFiles, extraContents, allMarks]);

    const shown = files.slice(0, MAX_CHIPS);
    const hidden = files.length - shown.length;
    const stale = Object.values(dirtyFiles || {}).some(Boolean);

    return (
        <div
            className="shrink-0 px-3 py-1.5 flex flex-col gap-1 [border-bottom:1px_solid_var(--vsc-border)] [background:var(--vsc-sidebar-bg)]"
            data-testid="webpage-code-strip"
        >
            <div className="flex items-center gap-1.5 flex-wrap">
                {shown.map(file => (
                    <FileChip
                        key={file.key}
                        t={t}
                        file={file}
                        active={file.key === activeKey}
                        dirty={!!dirtyFiles[file.key]}
                        onOpen={onOpen}
                    />
                ))}
                {hidden > 0 && (
                    <span className="text-[11px] text-[var(--vsc-fg-muted)]">
                        {t('webpages.code.more_files', '+{count} more', { count: hidden })}
                    </span>
                )}
                <Totals t={t} count={files.length} totalBytes={totalBytes} complete={bytesComplete} />
            </div>
            <div className="text-[11px]">
                <Legend t={t} marksState={marksState || { marks: [], loading: false, available: false }}
                    readOnly={readOnly} stale={stale} />
            </div>
        </div>
    );
}
