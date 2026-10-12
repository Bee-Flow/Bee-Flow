import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BF_FAMILIES, buildBfDecorations, familyClass, familyOf, publishedFate, survivesPublishing } from './bfDecorations';
import { buildCodeFiles, formatBytes, markFileKey } from './webpageCodeFiles';
import { api } from './webpagesApi';
import useTranslation from '../../hooks/useTranslation';

/**
 * De strip boven de editor in de Code-tab: welke bestanden heeft deze pagina,
 * hoe groot zijn ze, en wat betekenen de markeringen in de code?
 *
 * ── TWEE DINGEN DIE DIT SCHERM NIET MAG BEWEREN ─────────────────────
 *
 * 1. "DEZE PAGINA HEEFT DRIE BESTANDEN." Dat is de uitzondering, niet de
 *    regel: een react-mui-project heeft zijn app in `src/`, een vanilla-project
 *    mag bestanden naast de slots zetten. `webpageCodeFiles.js` bouwt daarom de
 *    lijst uit wat er IS — inclusief een bestand dat alleen de server kent.
 *
 * 2. "ER ZIJN GEEN KOPPELINGEN." Als de markeringen niet konden worden
 *    berekend — de aanroep faalde, of de server kon de bestanden niet lezen —
 *    dan zegt de legenda dát, in plaats van te zwijgen. Een pagina zonder
 *    markeringen mag er niet uitzien als een pagina zonder koppelingen; dat is
 *    de hele reden dat deze legenda bestaat.
 *
 * ── ÉÉN LEZING, TWEE GEBRUIKERS ─────────────────────────────────────
 *
 * `useBfMarks` haalt de markeringen op bij `GET /api/webpages/:id/bindings` —
 * dezelfde parser als de rest van W4 (`core/webpages/webpageBindings.js`), die
 * het vocabulaire uit `core/webpages/bfElements.js` haalt. De IDE geeft die
 * uitslag aan twee kanten door: aan deze strip (de legenda) en aan Monaco (de
 * decoraties). Eén lezing, dus de legenda kan niet iets anders beweren dan de
 * editor tekent.
 *
 * ── DE MARKERINGEN KOMEN VAN DE OPGESLAGEN KOPIE ────────────────────
 *
 * De server leest wat er in de opslag staat, de editor toont wat er in het
 * scherm staat. Zolang er niets onopgeslagen is, is dat hetzelfde; daarna
 * schuiven de regelnummers. De strip zegt dat er dan bij (`legend_stale`) en
 * de IDE haalt de markeringen opnieuw op zodra er is opgeslagen.
 */

/** Hoeveel bestanden de strip hoogstens uitschrijft voordat hij gaat tellen. */
const MAX_CHIPS = 24;

/**
 * De markeringen van één pagina.
 *
 * Vier standen, en ze moeten verschillend blijven: aan het laden, mislukt
 * (`error`), gelezen-maar-onleesbaar (`scanned:false` van de server) en gelezen.
 * De eerste drie leveren allemaal GEEN markeringen op, en alleen de laatste
 * betekent "deze pagina heeft er geen".
 *
 * @param {string} webpageId
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]   niet ophalen als de Code-tab dicht is
 * @param {*} [opts.reloadKey]       verandert → opnieuw ophalen (de IDE geeft
 *                                   hier het tijdstip van de laatste opslag)
 */
export function useBfMarks(webpageId, { enabled = true, reloadKey = null } = {}) {
    // Begint op `loading`, niet op "niets": tussen de eerste render en het
    // effect eronder zou de legenda anders één frame lang de waarschuwing
    // tonen dat de markering niet kon worden berekend, terwijl er nog niet eens
    // is gekeken. Dat is precies de bewering die dit scherm niet mag doen.
    const [state, setState] = useState({ loading: true, error: null, data: null });

    const load = useCallback(async () => {
        if (!webpageId) return;
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const body = await api(`/${encodeURIComponent(webpageId)}/bindings`);
            setState({ loading: false, error: null, data: body && body.elements ? body.elements : null });
        } catch (e) {
            setState({ loading: false, error: e?.message || 'failed', data: null });
        }
    }, [webpageId]);

    useEffect(() => {
        // Niet ophalen is iets anders dan aan het ophalen zijn: dan uit de
        // laadstand, zodat de legenda niet blijft hangen op "aan het uitzoeken".
        if (!enabled || !webpageId) {
            setState(s => (s.loading ? { ...s, loading: false } : s));
            return;
        }
        load();
    }, [enabled, webpageId, reloadKey, load]);

    const data = state.data;
    return {
        loading: state.loading,
        error: state.error,
        // `scanned:false` is iets anders dan een mislukte aanroep, maar voor de
        // lezer komt het op hetzelfde neer: er is niets berekend. Beide standen
        // blijven apart leesbaar (`error`), en `available` vat samen of er
        // markeringen zijn om te tonen.
        available: !!(data && data.scanned),
        marks: data && Array.isArray(data.marks) ? data.marks : [],
        counts: (data && data.counts) || { total: 0, known: 0, unknown: 0 },
        unknownTags: (data && data.unknownTags) || [],
        truncated: (data && data.truncated) || 0,
        reload: load,
    };
}

/** De naam van een familie, zoals de auteur ze in Studio kent. */
export function familyLabel(t, family) {
    switch (family) {
        case 'datatable': return t('webpages.code.family_datatable', 'Data table');
        case 'automation': return t('webpages.code.family_automation', 'Automation');
        case 'agent': return t('webpages.code.family_agent', 'Agent');
        case 'incomplete': return t('webpages.code.family_incomplete', 'Not linked yet');
        case 'unknown': return t('webpages.code.family_unknown', 'Not recognised');
        // Een familie die het vocabulaire later toevoegt: liever de kale sleutel
        // dan niets, zodat hij opvalt in plaats van te verdwijnen.
        default: return family;
    }
}

/**
 * Waar deze markering aan hangt, in één stuk tekst.
 *
 * `dynamic` is met opzet een eigen antwoord: de auteur HEEFT een adres
 * opgeschreven, maar de pagina bouwt het terwijl ze draait. Dat als "niet
 * gekoppeld" tonen zou hem naar een fout laten zoeken die er niet is.
 */
function targetText(t, mark) {
    if (mark.targetId) return mark.targetId;
    if (mark.dynamic) return t('webpages.code.dynamic_target', 'worked out while the page runs');
    if (Array.isArray(mark.missing) && mark.missing.length) return null;
    if (mark.fallback) return t('webpages.code.page_agent', "this page's own link");
    return null;
}

/** Het label achter de regel in de editor. */
function decorationLabel(t, group) {
    const tags = [...new Set(group.marks.map(m => m.tag))].join(', ');
    const first = group.marks[0];
    if (group.marks.length > 1) return `${tags} · ${familyLabel(t, group.family)}`;
    const target = targetText(t, first);
    if (target) return `${tags} → ${target}`;
    return `${tags} · ${familyLabel(t, group.family)}`;
}

/** De tooltip: hetzelfde, plus wat er ontbreekt. */
function decorationHover(t, group) {
    const lines = group.marks.map((mark) => {
        const target = targetText(t, mark);
        const head = target
            ? `\`${mark.tag}\` → ${target}`
            : `\`${mark.tag}\` · ${familyLabel(t, familyOf(mark))}`;
        if (Array.isArray(mark.missing) && mark.missing.length) {
            return `${head} — ${t('webpages.code.needs_attribute', 'needs {attr}', { attr: mark.missing.join(', ') })}`;
        }
        // WAT ER GEBEURT ZODRA DE PAGINA GEPUBLICEERD IS. De zin komt uit de
        // gespiegelde registry, dus hij is precies dezelfde als wat de lezer op
        // /w/<slug> te zien krijgt. Zonder dit las een knop die daar dood is als
        // een gelijkwaardige koppeling.
        const fate = publishedFate(mark.tag);
        if (fate && !survivesPublishing(mark.tag) && fate.notice) {
            return `${head}\n\n${t('webpages.code.published_fate', 'Once published: {notice}', { notice: fate.notice })}`;
        }
        return head;
    });
    return lines.join('\n\n');
}

/**
 * De Monaco-decoraties voor ÉÉN bestand.
 *
 * Hier komen de twee helften samen: `bfDecorations.js` weet hoe een decoratie
 * eruitziet, `t` weet hoe de tekst luidt. De IDE roept dit aan; de editor krijgt
 * kant-en-klare data en hoeft niets van `bf-*` te weten.
 */
export function fileDecorations({ marks, fileKey, t }) {
    if (!fileKey) return [];
    const mine = (Array.isArray(marks) ? marks : []).filter(m => markFileKey(m) === fileKey);
    return buildBfDecorations(mine, {
        label: (group) => decorationLabel(t, group),
        hover: (group) => decorationHover(t, group),
    });
}

/** Eén bestand in de strip. */
function FileChip({ t, file, active, dirty, onOpen }) {
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
            <span style={{ opacity: 0.75 }}>{label}</span>
            {dirty && (
                <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: 'var(--vsc-fg-muted)' }}
                    title={t('webpages.code.unsaved', 'Unsaved changes')}
                />
            )}
            {file.marks > 0 && (
                <span
                    className="px-1 rounded"
                    style={{ background: 'var(--vsc-border)', color: 'var(--vsc-fg)' }}
                    title={t('webpages.code.marks_in_file', '{count} highlighted lines', { count: file.marks })}
                >
                    {file.marks}
                </span>
            )}
        </Tag>
    );
}

/**
 * Hoeveel bestanden, en hoe groot samen.
 *
 * Zit er een bestand bij waarvan we de bytes niet kennen, dan is het totaal een
 * ONDERgrens en zegt het dat ook. Een som die stilzwijgend een bestand overslaat
 * is een verkeerd getal, en dat is erger dan een vaag getal.
 */
function Totals({ t, count, totalBytes, complete }) {
    const total = formatBytes(totalBytes);
    return (
        <span className="text-[11px] ml-auto" style={{ color: 'var(--vsc-fg-muted)' }}>
            {t(count === 1 ? 'webpages.code.files_count' : 'webpages.code.files_count_plural',
                count === 1 ? '{count} file' : '{count} files', { count })}
            {total ? ' · ' : ''}
            {total && (complete ? total : t('webpages.code.total_at_least', 'at least {size}', { size: total }))}
        </span>
    );
}

/** De legenda: wat de tinten betekenen — of waarom er geen zijn. */
function Legend({ t, marksState, readOnly, stale }) {
    const perFamily = useMemo(() => {
        const counts = new Map();
        for (const mark of marksState.marks) {
            const family = familyOf(mark);
            counts.set(family, (counts.get(family) || 0) + 1);
        }
        // Vaste volgorde: het vocabulaire eerst, de twee uitzonderingen erachter.
        return BF_FAMILIES.filter(f => counts.has(f)).map(f => ({ family: f, count: counts.get(f) }));
    }, [marksState.marks]);

    // Hoeveel van deze koppelingen het publiceren NIET overleven. Drie van de vijf
    // elementen zijn op een gepubliceerde pagina inert (er draait daar geen JS),
    // en dit scherm is het enige dat de koppelingen laat zien — dus het hoort ook
    // dít te laten zien.
    const inertOnPublish = useMemo(
        () => marksState.marks.filter(m => m.known !== false && !survivesPublishing(m.tag)).length,
        [marksState.marks],
    );

    if (readOnly) {
        return (
            <span style={{ color: 'var(--vsc-fg-muted)' }}>
                {t('webpages.code.legend_owner_only', 'Only the page owner can see which lines link to Studio.')}
            </span>
        );
    }

    if (marksState.loading) {
        return (
            <span className="flex items-center gap-1.5" style={{ color: 'var(--vsc-fg-muted)' }}>
                <Loader2 size={11} className="animate-spin" />
                {t('webpages.code.legend_loading', 'Working out the Studio links…')}
            </span>
        );
    }

    // De stand die deze legenda bestaat om te tonen: er is niets berekend, dus
    // het ONTBREKEN van markeringen zegt niets over de pagina.
    if (!marksState.available) {
        return (
            <span className="flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--warning-ink, #8a5a00)' }}>
                <AlertTriangle size={11} />
                {t('webpages.code.legend_unavailable',
                    'The Studio links in this code could not be worked out, so nothing is highlighted. This page may still have links.')}
                <button
                    type="button"
                    onClick={marksState.reload}
                    className="underline inline-flex items-center gap-1"
                    style={{ color: 'inherit' }}
                >
                    <RefreshCw size={10} /> {t('webpages.retry', 'Try again')}
                </button>
            </span>
        );
    }

    if (!perFamily.length) {
        return (
            <span style={{ color: 'var(--vsc-fg-muted)' }}>
                {t('webpages.code.legend_none', 'Nothing in this code links to Studio yet.')}
            </span>
        );
    }

    return (
        <span className="flex items-center gap-2 flex-wrap" style={{ color: 'var(--vsc-fg-muted)' }}>
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
            {marksState.truncated > 0 && (
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
 * @param {object} props.marksState       de uitslag van `useBfMarks`
 * @param {string} [props.activeKey]      het bestand dat de editor toont
 * @param {function} [props.onOpen]       (key) => void — open dit bestand
 * @param {object} [props.dirtyFiles]     editor-sleutel → onopgeslagen?
 * @param {boolean} [props.readOnly]      geen eigenaar: /bindings is eigenaar-only
 */
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
}) {
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
            className="shrink-0 px-3 py-1.5 flex flex-col gap-1"
            style={{ borderBottom: '1px solid var(--vsc-border)', background: 'var(--vsc-sidebar-bg)' }}
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
                    <span className="text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
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
