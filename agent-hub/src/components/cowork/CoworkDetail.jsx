/**
 * The right-hand pane: one cowork item in full — what it does, when it runs
 * next, and how every run went.
 *
 * This used to be reachable only through Studio → Cowork while the thing that
 * created it lived under a different name in the sidebar. It is now the detail
 * half of the Cowork page itself.
 *
 * Four layers in one scrolling column, in the order someone reads them
 * (CW-06, CW-08, CW-11, CW-13): who this is and what it is doing right now →
 * the brief in the user's own words, with the context it runs under → the
 * figures → every run.
 *
 * TWO PILLS THE ARTBOARD DRAWS ARE NOT HERE, deliberately:
 *
 *   - "Prijslijst 2026" and "Offertes" (a knowledge base and a table). A
 *     cowork item has no knowledge-base or datatable binding at all — that is
 *     new datamodel, CW-09 — so those pills could only ever name a source
 *     this run will not read.
 *   - "Privacyschild aan". The non-agent run path calls the adapter directly
 *     with no shield in it (CW-10). The pill is a runtime claim, and on a
 *     privacy product a claim you cannot keep is worse than a missing pill.
 *     It arrives with the shield itself, not before it.
 *
 * Every pill that IS here states something the item actually carries.
 */
import { CalendarClock, Clock, LayoutGrid, Pause, Pencil, Play, Power, Trash2 } from 'lucide-react';
import React from 'react';
import CoworkEditForm from './CoworkEditForm';
import CoworkRunHistory from './CoworkRunHistory';
import { describeMoment, repeatLabel } from './coworkSchedule';
import CoworkStats from './CoworkStats';
import { coworkStatus } from './coworkStatus';
import { useTranslation } from '../../hooks/useTranslation';
import { TIER_META, tierLabel } from '../licensing/tierMeta';
import { kindColorVar, kindIcon, kindTileStyle } from '../shared/kindColors';
import { statusLabel } from '../shared/statusTokens';

const AgentIcon = kindIcon('agent');

/**
 * One context pill. The colour is always a kind/type token from index.css
 * (through kindColors), never a colour picked here — a clock pill is the same
 * teal as a trigger node in the Builder because it means the same thing.
 */
function Pill(props) {
    const Glyph = props.icon;
    const { tone, children } = props;
    return (
        <span
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11.5px] max-w-full"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
            <Glyph aria-hidden="true" className="w-3 h-3 flex-shrink-0" style={{ color: tone }} />
            <span className="truncate">{children}</span>
        </span>
    );
}

/** "Every weekday 08:00", "Every week", or "Runs once". */
function cadenceText(item, t) {
    if (!item.repeatInterval) return t('cowork.detail.runs_once', 'Runs once');
    const label = repeatLabel(item.repeatInterval, t);
    return item.timeOfDay ? `${label} ${item.timeOfDay}` : label;
}

/** "Running since 08:00:04" — the clock the artboard puts in the header. */
function startedAtClock(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
}

/**
 * The header: who this is, what it is doing right now, and the actions.
 *
 * Split out so the pane below it reads as four layers rather than one long
 * function — and so the "running since" decision has one place to live.
 */
function DetailHeader({ item, status, t, busy, onEdit, onToggle, onDelete, onRunNow }) {
    const tile = kindTileStyle('agent', 26);
    // The status word carries the pill on its own EXCEPT while a run is in
    // flight and the server told us when it started. That is the one moment
    // the word alone is not enough: "Running" says nothing about whether this
    // started four seconds or four hours ago (CW-06). The open run's start
    // time comes from the run row, not from lastStatus — see routes/cowork.js.
    const runningSince = status.labelKey === 'run_status.running'
        ? startedAtClock(item.currentRunStartedAt)
        : '';
    const tone = status.cssVar || 'var(--text-tertiary)';
    const secondary = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50';
    const secondaryStyle = { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' };

    return (
        <div
            className="flex items-center gap-2.5 px-5 py-2.5 border-b flex-wrap"
            style={{ borderColor: 'var(--border-subtle)' }}
        >
            <div style={tile.tile}><AgentIcon aria-hidden="true" style={tile.glyph} /></div>
            <h2 className="text-[14px] font-semibold truncate min-w-0" style={{ color: 'var(--text-primary)' }}>
                {item.title || t('cowork.detail.untitled', 'Untitled cowork')}
            </h2>
            <span
                data-testid="cowork-status"
                data-status-key={status.labelKey}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11.5px] flex-shrink-0"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
                <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full" style={{ background: tone }} />
                {runningSince
                    ? t('cowork.detail.running_since', 'Running since {time}', { time: runningSince })
                    : statusLabel(t, status)}
            </span>

            <div className="ml-auto flex items-center gap-1.5">
                <button
                    type="button" onClick={onEdit} disabled={busy}
                    data-testid="cowork-edit" className={secondary} style={secondaryStyle}
                >
                    <Pencil className="w-3.5 h-3.5" />{t('cowork.detail.edit', 'Edit')}
                </button>
                <button
                    type="button" onClick={() => onToggle(item.id)} disabled={busy}
                    data-testid="cowork-toggle" className={secondary} style={secondaryStyle}
                >
                    {item.isActive ? <Pause className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                    {item.isActive ? t('cowork.detail.pause', 'Pause') : t('cowork.detail.resume', 'Resume')}
                </button>
                <button
                    type="button" onClick={() => onDelete(item)} disabled={busy}
                    data-testid="cowork-delete"
                    aria-label={t('cowork.detail.delete', 'Delete this cowork')}
                    className="p-1.5 rounded-lg border text-red-600 dark:text-red-400 disabled:opacity-50"
                    style={{ borderColor: 'var(--border-subtle)' }}
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
                {/* The one primary action on the pane. Accent tokens, not the
                    artboard's ink fill: the fill is a hex, and this product
                    follows the admin's accent through eight themes
                    (COMPLETED-STAGES.md:412). */}
                <button
                    type="button"
                    onClick={() => onRunNow(item.id)}
                    disabled={busy || item.lastStatus === 'running'}
                    data-testid="cowork-run-now"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                >
                    <Play className="w-3.5 h-3.5" />{t('cowork.detail.run_now', 'Run now')}
                </button>
            </div>
        </div>
    );
}

/** The brief in the user's own words, and the context it runs under. */
function AssignmentCard({ item, agents, t }) {
    const agent = item.agentId && Array.isArray(agents)
        ? agents.find(a => a.id === item.agentId)
        : null;
    const tierKey = item.modelTier || null;
    const TierIcon = (tierKey && TIER_META[tierKey]?.Icon) || null;
    const appCount = Array.isArray(item.enabledApps) ? item.enabledApps.length : 0;

    return (
        <section
            className="rounded-[10px] border px-[18px] py-4 flex flex-col gap-2.5"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', boxShadow: 'var(--shadow-sm)' }}
            data-testid="cowork-brief"
        >
            <h3
                className="text-[10.5px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-tertiary)' }}
            >
                {t('cowork.detail.assignment', 'The assignment')}
            </h3>
            {/* Still plain text, still not Markdown: this is what the user
                typed, and a brief that opened with "# Weekly" is a sentence,
                not a heading. */}
            <p
                className="text-[13px] leading-[21px] max-w-[820px] whitespace-pre-wrap break-words"
                style={{ color: 'var(--text-secondary)' }}
            >
                {item.prompt}
            </p>
            <div className="flex gap-1.5 flex-wrap pt-0.5">
                <Pill icon={Clock} tone="var(--type-trigger)">{cadenceText(item, t)}</Pill>
                {item.isActive && item.nextRunAt && (
                    <Pill icon={CalendarClock} tone="var(--type-trigger)">
                        {t('cowork.detail.next_run', 'next {when}', { when: describeMoment(item.nextRunAt) })}
                    </Pill>
                )}
                {agent && <Pill icon={AgentIcon} tone={kindColorVar('agent')}>{agent.name}</Pill>}
                {TierIcon && (
                    // The TIER, not a model name. Models are bound to tiers on
                    // purpose, and under `auto` no model has been chosen yet
                    // when this renders (B4).
                    <Pill icon={TierIcon} tone="var(--type-ai)">{tierLabel(tierKey)}</Pill>
                )}
                {appCount > 0 && (
                    <Pill icon={LayoutGrid} tone={kindColorVar('app')}>
                        {t(
                            appCount === 1 ? 'cowork.detail.app_count' : 'cowork.detail.app_count_plural',
                            appCount === 1 ? '{count} app' : '{count} apps',
                            { count: appCount },
                        )}
                    </Pill>
                )}
            </div>
        </section>
    );
}

export default function CoworkDetail({
    item, agents, onRunNow, onToggle, onDelete, onSave, busy, reloadKey,
    editing, onEdit, onCancelEdit, saveError,
}) {
    const { t } = useTranslation();
    const status = coworkStatus(item);

    if (editing) {
        return (
            <div className="h-full overflow-y-auto custom-scrollbar p-5" data-testid="cowork-detail">
                <h2 className="text-[17px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                    {t('cowork.detail.edit_heading', 'Edit cowork')}
                </h2>
                <CoworkEditForm
                    item={item}
                    agents={agents}
                    onSave={onSave}
                    onCancel={onCancelEdit}
                    saving={busy}
                    error={saveError}
                />
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="cowork-detail">
            <DetailHeader
                item={item}
                status={status}
                t={t}
                busy={busy}
                onEdit={onEdit}
                onToggle={onToggle}
                onDelete={onDelete}
                onRunNow={onRunNow}
            />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-[26px] py-[22px] flex flex-col gap-[18px]">
                <AssignmentCard item={item} agents={agents} t={t} />
                <CoworkStats coworkId={item.id} reloadKey={reloadKey} />
                <CoworkRunHistory coworkId={item.id} reloadKey={reloadKey} />
            </div>
        </div>
    );
}
