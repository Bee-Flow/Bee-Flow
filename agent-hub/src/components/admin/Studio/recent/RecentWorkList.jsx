import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RECENT_LIMIT, recentSourcesFor, runRecentWork, statusLabel, statuslessKinds } from './recentWork';
import { useTranslation } from '../../../../hooks/useTranslation';
import { formatRelativeTime } from '../../../../utils/dateFormatters';
import { kindColorVar, kindIcon } from '../../../shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';
import { studioSectionLabel } from '../studioNav';

/**
 * "Laatst bewerkt" — de tweede lijst op het Startscherm van Studio (Track H3).
 *
 * Wat er op een rij staat en waar het vandaan komt staat in recentWork.js;
 * dit bestand tekent het. Drie dingen zijn hier de moeite van het lezen waard.
 *
 * ── Eén woord per rij, en twee manieren om er geen te hebben ────────────────
 *
 * Zes van de negen lijsten dragen een status; drie niet (kennisbanken,
 * skills, oplossingen). Een rij van die drie krijgt GEEN groen vinkje en ook
 * geen lege plek — allebei lezen als "in orde" — maar het woord "No status"
 * in neutrale inkt, met de reden in de tooltip en één zin onder de lijst. Een
 * rij van de andere zes waarvan het veld ontbrak zegt "Status unknown": een
 * ander feit, een andere zin.
 *
 * ── Kort is niet hetzelfde als klaar ────────────────────────────────────────
 *
 * Een lege lijst heeft twee oorzaken en maar één daarvan is goed nieuws.
 * `complete` (geen enkele sectie die omviel) is het enige recht om "nog niets
 * bewerkt" te zeggen; anders staat er dat er niet overal gekeken kon worden,
 * mét de namen van de lijsten die niet meededen. Dezelfde regel als
 * AttentionList ernaast, en om dezelfde reden.
 *
 * Een sectie die de server WEIGERT (403) of die achter een licentie zit is
 * geen gat: daar valt voor deze persoon niets te bewerken. Die zwijgt, want
 * een waarschuwing die iedereen elke dag ziet leert iedereen waarschuwingen
 * te negeren.
 *
 * Twee dingen zijn dat WEL, en allebei zijn ze onzichtbaar als je er niet naar
 * vraagt: de poorten die nog geen antwoord hebben (`gatesResolved` false — dan
 * staan de gegate secties niet eens in de lijst, dus ze kunnen niet gemist
 * worden) en een runtime-module die deze build niet kan uitlezen. Allebei
 * krijgen ze een zin, en allebei houden ze "nog niets bewerkt" tegen.
 *
 * ── Eén keer ophalen, bij het openen ────────────────────────────────────────
 *
 * Geen timer. De rail pollt de aantallen al; deze lijst kost maximaal negen
 * verzoeken en die horen bij het openen van het scherm, niet bij elke halve
 * minuut dat het openstaat.
 */

/** Het statuswoord van een rij: altijd een woord, nooit een leeg vakje. */
function StatusWord({ t, status, testId }) {
    const label = statusLabel(status);
    return (
        <span
            data-testid={testId}
            data-status={status}
            title={label.hintFallback ? t(label.hintKey, label.hintFallback) : undefined}
            className="flex-shrink-0 text-[11px] font-medium"
            style={{ color: label.tone }}
        >
            {t(label.key, label.fallback)}
        </span>
    );
}

/**
 * Eén rij: waar het over gaat, in welke staat het is, en wanneer het veranderde.
 *
 * Het glyph komt als node binnen, niet als soortnaam — zo staat de opzoeking
 * in het register op dezelfde plek als bij AttentionList ernaast, en tekent
 * deze rij alleen.
 */
function RecentRow({ t, locale, entry, icon, onOpen }) {
    const when = entry.at === null ? null : formatRelativeTime(entry.updatedAt, { locale });
    return (
        <button
            type="button"
            onClick={onOpen || undefined}
            data-testid={`studio-recent-item-${entry.key}`}
            data-kind={entry.kind || undefined}
            className="w-full flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
        >
            {icon}
            <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                        {entry.name || t('studio.recent.untitled', 'Untitled')}
                    </span>
                    <StatusWord t={t} status={entry.status} testId={`studio-recent-status-${entry.key}`} />
                    {/* Alleen een tijd als er een leesbare tijd was. "just now"
                        boven een onleesbare tijdstempel is een verzinsel. */}
                    {when && (
                        <span className="flex-shrink-0 text-[11px] text-[var(--text-tertiary)]" data-testid={`studio-recent-when-${entry.key}`}>
                            {when}
                        </span>
                    )}
                </span>
                {entry.description && (
                    <span className="block truncate text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]">
                        {entry.description}
                    </span>
                )}
            </span>
        </button>
    );
}

/**
 * De zin onder de kop. Precies één van drie, en de eerste twee zijn het paar
 * dat dit scherm uit elkaar moet houden.
 */
function StatusLine({ t, total, complete, missing, gatesUnknown, unsupported }) {
    // Eén of meer lijsten, met hun eigen naam erbij. Meervoud via de sleutel,
    // nooit "list(s)" (KnowledgeStudio/plural.js).
    const unreadable = () => nOf(
        t, 'studio.recent.unreadable', missing.length,
        'Could not read this list: {sections}',
        'Could not read these lists: {sections}',
        { sections: missing.join(', ') },
    );
    // De poorten zelf hadden nog geen antwoord: de gegate secties stonden er
    // dan niet eens, dus ze zijn niet als "geweigerd" te melden — alleen als
    // niet-gevraagd. Zonder deze zin is dat stilte met een geruststelling erop.
    const gatesLine = () => t(
        'studio.recent.gates_unknown',
        'Some lists were not asked for yet because your access is still being checked.',
    );
    // Geen meervoudspaar: de zin somt namen op, dus hij leest hetzelfde voor
    // één en voor drie.
    const unsupportedLine = () => t(
        'studio.recent.unsupported',
        'This version cannot list what is in {sections}.',
        { sections: unsupported.join(', ') },
    );
    const details = [
        missing.length > 0 ? unreadable() : '',
        gatesUnknown ? gatesLine() : '',
        unsupported.length > 0 ? unsupportedLine() : '',
    ].filter(Boolean).join(' ');

    if (total === 0 && complete) {
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]" data-testid="studio-recent-empty">
                {t('studio.recent.empty', 'Nothing edited yet.')}
            </p>
        );
    }
    if (total === 0) {
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-recent-empty-unread">
                {t('studio.recent.empty_unreadable', 'Some lists could not be read, so this is not the whole picture — not "nothing here".')}
                {details ? ` ${details}` : ''}
            </p>
        );
    }
    if (!complete) {
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-recent-partial">
                {details}
            </p>
        );
    }
    return null;
}

export default function RecentWorkList({
    sections = null, onNavigate = null, limit = RECENT_LIMIT, gatesResolved = true,
}) {
    const { t, locale } = useTranslation();
    const [state, setState] = useState(null);

    // De secties zijn elke render een nieuwe array; de ids erin niet. Het
    // ophalen hangt aan die ids, zodat een render van de ouder geen tweede
    // ronde verzoeken uitlokt.
    const asked = useMemo(() => recentSourcesFor(sections).asked, [sections]);
    const askedKey = asked.map((a) => a.sectionId).join(',');

    // Bijgehouden in een effect, niet tijdens de render: een ref die tijdens
    // het renderen wordt geschreven is een render met een bijwerking. Staat
    // BOVEN het effect dat hem leest — dat is de volgorde waarin ze lopen.
    const sectionsRef = useRef(sections);
    useEffect(() => { sectionsRef.current = sections; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const result = await runRecentWork(sectionsRef.current, { limit, gatesResolved });
            if (!cancelled) setState(result);
        })();
        return () => { cancelled = true; };
    }, [askedKey, limit, gatesResolved]);

    // Vóór het eerste antwoord wordt er niets beweerd — geen lege lijst, geen
    // geruststelling. Dezelfde regel als de aantallen op de rail.
    if (!state) return null;

    const { items, unavailable, complete, unsupported = [] } = state;
    // De namen van de lijsten die niet gelezen konden worden, uit hetzelfde
    // register als de rail — "Agents" hier en "Agents" daar.
    const byId = new Map((sections || []).filter(Boolean).map((app) => [app.id, app]));
    const nameOf = (id) => studioSectionLabel(byId.get(id), t, locale) || id;
    // 'gates' is geen sectie maar het ontbrekende antwoord op de vraag WELKE
    // secties er zijn; het krijgt daarom zijn eigen zin en geen naam in de rij.
    const gatesUnknown = unavailable.includes('gates');
    const missing = unavailable.filter((id) => id !== 'gates').map(nameOf);
    const statusless = statuslessKinds(items);

    return (
        <section className="mt-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3" data-testid="studio-recent">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
                {t('studio.recent.title', 'Recently edited')}
            </h2>

            <StatusLine
                t={t} total={items.length} complete={complete} missing={missing}
                gatesUnknown={gatesUnknown} unsupported={unsupported.map(nameOf)}
            />

            {items.length > 0 && (
                <div className="mt-2 -mx-1">
                    {items.map((entry) => {
                        const KindIcon = kindIcon(entry.kind);
                        return (
                            <RecentRow
                                key={entry.key}
                                t={t}
                                locale={locale}
                                entry={entry}
                                icon={KindIcon
                                    ? <KindIcon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: kindColorVar(entry.kind) }} strokeWidth={1.75} aria-hidden="true" />
                                    : null}
                                onOpen={onNavigate ? () => onNavigate(entry.path) : null}
                            />
                        );
                    })}
                </div>
            )}

            {/* Zonder deze zin is een rij met "No status" een lege plek zonder
                uitleg — en dat is precies wat dit scherm niet mag tonen. */}
            {statusless.length > 0 && (
                <p className="mt-1.5 text-[11.5px] text-[var(--text-tertiary)]" data-testid="studio-recent-statusless">
                    {t('studio.recent.statusless', 'Some kinds do not report a status in this list, so none is shown for them.')}
                </p>
            )}
        </section>
    );
}
