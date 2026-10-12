import { AppWindow, ChevronDown, ChevronRight, ExternalLink, MousePointerClick } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import useAutomationApi from '../../../hooks/useAutomationApi';
import useTranslation from '../../../hooks/useTranslation';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import { segmentForSection } from '../../admin/Studio/studioRoutes';

/**
 * "Used by 2 buttons": the strip under the automation editor's header.
 *
 * Reads `GET /api/automation/:id/usage`, built from the `automation_usage`
 * index (one row per app, action and automation, written on every app save by
 * appStudio/automationUsageSync.js).
 *
 * It shows ONLY when at least one App Studio button runs the automation. A
 * pending answer, a failed read, an empty list and an index that is not
 * complete yet all render nothing: the old "No app button runs this automation
 * yet" / "Could not check" / "Not checked yet" lines sat under every header as
 * noise (owner, 2026-09-28), and deleting an automation keeps its own server-side
 * 409 check against buttons that still use it.
 *
 * Links only when the SERVER said `canOpen`, never derived client-side.
 */
/** The capsule's sentence; only drawn when at least one button runs the automation. */
function capsuleText(t, count) {
    return nOf(t, 'automation_editor.used_by.count', count,
        'Used by {count} button', 'Used by {count} buttons');
}

export default function UsedByButtonsCapsule({ automationId, onNavigate = null }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    // The answer travels WITH the id it belongs to, so switching automations
    // never shows the previous automation's count. `usage`: undefined | null | Array.
    const [answer, setAnswer] = useState({ id: null, usage: undefined });
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!automationId) return undefined;
        let alive = true;
        api.getUsage(automationId)
            .then((r) => {
                if (!alive) return;
                // A body without a list is not an answer.
                setAnswer({ id: automationId, usage: Array.isArray(r?.usage) ? r.usage : null });
            })
            .catch(() => { if (alive) setAnswer({ id: automationId, usage: null }); });
        return () => { alive = false; };
    }, [automationId, api]);

    // An answer about ANOTHER automation counts as not yet received.
    const usage = answer.id === automationId ? answer.usage : undefined;

    if (!automationId) return null;
    if (usage === undefined) return null;

    const rows = usage === null ? [] : usage;
    const count = rows.length;
    // Only an automation that buttons actually run gets the strip. "No app button
    // runs this automation yet" (and the unknown / not-checked variants) sat under
    // every builder header as a permanent line of noise (owner, 2026-09-28).
    // The delete path keeps its own 409 check, so hiding them here loses no
    // safety.
    if (count === 0) return null;
    const text = capsuleText(t, count);

    return (
        <div className="px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 text-[11px] min-w-0">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                data-testid="usedby-buttons-capsule"
                title={t('automation_editor.used_by.toggle', 'Show which buttons run this automation')}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
            >
                <MousePointerClick className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{text}</span>
                {open
                    ? <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                    : <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />}
            </button>

            {open ? (
                <ul
                    aria-label={t('automation_editor.used_by.list_label', 'The app buttons that run this automation')}
                    className="mt-1.5 flex flex-col gap-1 list-none p-0 m-0"
                >
                    {rows.map((row) => (
                        <UsageRow
                            key={`${row.consumerId}/${row.refId}`}
                            row={row}
                            t={t}
                            onNavigate={onNavigate}
                        />
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

/**
 * Eén regel: app › knop.
 *
 * De naam van de app komt uit de LEFT JOIN op de index; is hij leeg, dan is de
 * app weg of nog niet joinbaar en toont de regel het kale id — eerlijk, en
 * onbruikbaar voor wie het niet toekomt. Het knoplabel komt uit de definitie
 * zoals die bij de laatste save stond; een actie die aan geen enkele knop hangt
 * zegt dat met zoveel woorden in plaats van met een lege plek.
 */
function UsageRow({ row, t, onNavigate }) {
    const appText = row.consumerTitle || row.consumerId;
    const href = `/app/studio/${segmentForSection('apps')}/${encodeURIComponent(row.consumerId)}`;
    const buttonText = row.wired
        ? (row.label || row.nodeId || row.actionId)
        : t('automation_editor.used_by.unwired', 'Not wired to a button yet');

    return (
        <li className="flex items-center gap-1 min-w-0">
            <AppWindow className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            {row.canOpen ? (
                <a
                    href={href}
                    onClick={onNavigate ? (e) => { e.preventDefault(); onNavigate(href); } : undefined}
                    title={t('automation_editor.used_by.open_app', 'Open the app')}
                    className="inline-flex items-center gap-1 truncate text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline decoration-dotted underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] rounded"
                >
                    <span className="truncate">{appText}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
                </a>
            ) : (
                // Geen `canOpen` = geen link. De naam blijft staan (hij komt uit
                // een rij die deze kijker mocht lezen), maar een link die op een
                // 403 landt is erger dan geen link.
                <span className="truncate text-[var(--text-secondary)]">{appText}</span>
            )}
            <ChevronRight className="w-3 h-3 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <span
                title={row.screenId || undefined}
                className={`truncate ${row.wired ? 'text-[var(--text-secondary)]' : 'italic text-[var(--text-tertiary)]'}`}
            >
                {buttonText}
            </span>
        </li>
    );
}
