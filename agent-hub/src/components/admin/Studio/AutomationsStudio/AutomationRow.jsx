import { Trash2, Mail, Clock, Webhook, Bot, MousePointer2, MoreVertical } from 'lucide-react';
import React, { useState } from 'react';
import ContextMenu from './ContextMenu';
import { buildAutomationMenuItems } from './automationMenuItems';
import { automationStatusParts, roleOf, roleLabel } from './automationStatus';
import { useTranslation } from '../../../../hooks/useTranslation';
import { describeCron } from '../../../automation/Builder/flow/scheduleBuilderUtils';
import { STATUS_TOKENS, tokenFor } from '../../../shared/statusTokens';

/**
 * One row in the unified Automations sidebar. Used for both Automations and
 * Prompt Tasks; the parent tells us which `kind` so we can render the
 * right meta line and right-click menu items.
 *
 * Visual rules:
 *   - Mirrors SkillsStudio/AgentStudio: icon + name + meta + hover trash.
 *   - The status dot takes its colour from the shared status table
 *     (components/shared/statusTokens.ts), like the executions table and the
 *     run views. It used to carry its own bg-red-500/bg-amber-500/
 *     bg-emerald-500 ladder, which is how one Studio came to draw a running
 *     automation amber in the sidebar and blue in the executions list beside it.
 *   - The meta line opens with the status in the header's own words
 *     ("Draft · never live", "Live · v3", "Paused", "2 changes not live"),
 *     so a row and the open automation never describe it differently.
 *   - An automation shared with the caller wears a role chip (Can run / Can
 *     view / Can edit), and the actions narrow to what that role may do:
 *     only the owner moves it to the trash, only owner and editors change it,
 *     and a viewer may still copy or export it.
 */
const TONE_CLASS = {
    draft: 'text-[var(--text-tertiary)]',
    live: 'text-[var(--success)]',
    paused: 'text-[var(--text-tertiary)]',
    pending: 'text-[var(--warning)]',
};

export default function AutomationRow({
    automation,
    kind,
    selected,
    onSelect,
    onDuplicate,
    onExportJson,
    onCopyId,
    onDelete,
    onToggleActive,
    onOpenRuns,
    onMoveToFolder,
    canManage = true,
    liveRunning = false,
}) {
    const { t } = useTranslation();
    const [contextPos, setContextPos] = useState(null);

    const isAutomation = kind === 'automation';
    const isActive = !!automation.isActive;
    const role = isAutomation ? roleOf(automation) : 'owner';
    const isOwner = role === 'owner';
    const canEdit = isOwner || role === 'edit';
    // A viewer may read everything, so a copy or an export of it is theirs to make.
    const canRead = canEdit || role === 'view';
    const roleChip = roleLabel(role, t);
    // What this caller's role allows (server/automation/access.js); the server
    // refuses the rest anyway.
    const allowed = {
        onToggleActive: canEdit ? onToggleActive : undefined,
        onDuplicate: canRead ? onDuplicate : undefined,
        onExportJson: canRead ? onExportJson : undefined,
        onMoveToFolder: canEdit ? onMoveToFolder : undefined,
        onDelete: isOwner ? onDelete : undefined,
    };
    const statusParts = isAutomation ? automationStatusParts(automation, t) : [];
    const lastStatus = automation.lastStatus;
    // Live-running poll (from getActiveRuns) outranks the persisted
    // lastStatus so we get an n8n-style "● now executing" indicator
    // within ~5s of a run kicking off.
    // WHICH status the dot stands for is this row's decision; what that status
    // looks like is the table's. `tokenFor` rides along so the server's
    // `failed` spelling lands on the same red as `error`.
    //
    // A live run wears the same blue as a persisted `running` — they are the
    // same sentence, and the pulse is what adds the "right now". It used to be
    // --accent, which is org-brandable: on a green-branded tenant a running
    // automation and a finished one were one colour.
    //
    // Anything else on an active automation keeps the plain "this one is on"
    // green — an automation that has never run included. The dot's first job in
    // this sidebar is live-vs-paused, and grey on an active row reads as
    // switched off.
    const lastToken = tokenFor(lastStatus);
    const dotToken = liveRunning
        ? STATUS_TOKENS.running
        : !isActive
            ? STATUS_TOKENS.paused
            : lastToken === STATUS_TOKENS.error || lastToken === STATUS_TOKENS.running
                ? lastToken
                : STATUS_TOKENS.success;

    // PascalCase makes it explicit this is a React component, not a DOM tag —
    // otherwise a lowercase rename would silently emit a literal HTML tag.
    const TriggerIcon = isAutomation ? triggerIcon(automation) : Bot;
    const title = automation.title || (isAutomation ? 'Untitled automation' : 'Untitled task');
    // The name first, so a title the narrow sidebar cut short can still be
    // read in full; then the description, when there is one. A blank
    // description falls away instead of adding an empty line.
    const description = (automation.description || '').trim();
    const tooltip = description && description !== title ? `${title}\n${description}` : title;

    const meta = isAutomation ? automationMeta(automation) : taskMeta(automation);

    // Single source of truth for "can the user mutate this automation". Both the
    // context-menu opener and the hover-delete button honor it so users see
    // a consistent permission story regardless of how they try to act.
    const canMutate = !!onOpenRuns || (canManage && (
        (isAutomation && !!allowed.onToggleActive)
        || !!allowed.onDuplicate || !!allowed.onExportJson || !!onCopyId || !!allowed.onDelete || !!allowed.onMoveToFolder
    ));

    const onContextMenu = (e) => {
        if (!canMutate) return;
        e.preventDefault();
        setContextPos({ x: e.clientX, y: e.clientY });
    };

    // Left-click twin of onContextMenu — same menuItems, same ContextMenu
    // instance, just a different way to open it. Right-click only found the
    // per-row actions by accident; this is the discoverable one.
    const onMoreOptions = (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setContextPos({ x: rect.right, y: rect.bottom });
    };

    // One menu for every surface that lists automations — see automationMenuItems.
    const menuItems = buildAutomationMenuItems({
        isAutomation, isActive,
        onToggleActive: allowed.onToggleActive, onOpenRuns, onDuplicate: allowed.onDuplicate,
        onExportJson: allowed.onExportJson, onMoveToFolder: allowed.onMoveToFolder, onCopyId, onDelete: allowed.onDelete,
    });

    return (
        <>
            <div
                onClick={onSelect}
                onContextMenu={onContextMenu}
                className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-sm transition ${
                    selected
                        ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'
                }`}
                title={tooltip}
            >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 bg-current ${dotToken.solid}${liveRunning ? ' animate-pulse' : ''}`} />
                <TriggerIcon size={14} className="flex-shrink-0 text-[var(--text-tertiary)]" />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span className="truncate">{title}</span>
                        {roleChip && (
                            <span
                                data-testid="automation-role-chip"
                                className="shrink-0 text-[9px] font-semibold text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1 py-px rounded"
                            >
                                {roleChip}
                            </span>
                        )}
                    </div>
                    {(statusParts.length > 0 || meta) && (
                        <div className="text-[10.5px] text-[var(--text-tertiary)] truncate" data-testid="automation-row-meta" title={metaText(statusParts, meta)}>
                            {statusParts.map((p, i) => (
                                <React.Fragment key={p.tone}>
                                    {i > 0 && ' · '}
                                    <span data-status={p.tone} className={TONE_CLASS[p.tone]}>{p.text}</span>
                                </React.Fragment>
                            ))}
                            {statusParts.length > 0 && meta ? ' · ' : ''}
                            {meta}
                        </div>
                    )}
                </div>
                {canMutate && (
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                        {/* Visible-by-default (not hover-only) so the actions menu is
                            discoverable on touch/no-hover input too — that's the whole
                            point of this button; right-click stays the hover-input shortcut. */}
                        <button
                            type="button"
                            onClick={onMoreOptions}
                            title={t('automations.library.moreOptions', 'More options')}
                            aria-label={t('automations.library.moreOptions', 'More options')}
                            className="opacity-60 group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded p-0.5 transition"
                        >
                            <MoreVertical size={14} />
                        </button>
                        {allowed.onDelete && (
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); allowed.onDelete(); }}
                                title={t('automations.library.moveToTrash', 'Move to trash')}
                                aria-label={t('automations.library.moveToTrash', 'Move to trash')}
                                className="opacity-0 group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--error)] transition flex-shrink-0"
                            >
                                <Trash2 size={13} />
                            </button>
                        )}
                    </div>
                )}
            </div>
            <ContextMenu
                position={contextPos}
                items={menuItems}
                onClose={() => setContextPos(null)}
            />
        </>
    );
}

/** The meta line as plain text, for its tooltip once the sidebar cuts it short. */
function metaText(statusParts, meta) {
    return [...statusParts.map(p => p.text), meta].filter(Boolean).join(' · ');
}

function triggerIcon(automation) {
    const kind = automation.triggerType || automation.definition?.trigger?.kind || 'manual';
    if (kind === 'schedule') return Clock;
    if (kind === 'webhook') return Webhook;
    if (kind === 'manual') return MousePointer2;
    if (kind === 'app_event') return Mail; // today: only Gmail mail.new
    return Bot;
}

// Shallow cron syntax check — catches obvious typos (wrong field count, bad
// characters) without pulling in cron-parser. Full semantic validation lives
// server-side via /api/automation/_schedule/preview.
function isCronShapeValid(s) {
    if (!s || typeof s !== 'string') return false;
    const parts = s.trim().split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) return false;
    const fieldRe = /^[\d*/,\-?LW]+$/i;
    return parts.every(p => fieldRe.test(p));
}

function automationMeta(a) {
    const kind = a.triggerType || a.definition?.trigger?.kind || 'manual';
    if (kind === 'schedule' && a.scheduleCron) {
        if (!isCronShapeValid(a.scheduleCron)) {
            return `⚠ invalid schedule: ${a.scheduleCron}`;
        }
        // "Every day at 09:00 · Europe/Amsterdam", not `0 9 * * *` — this list
        // is where you check how often an automation runs, and a raw pattern is
        // not something most authors can read.
        return `${describeCron(a.scheduleCron)} · ${a.scheduleTz || 'UTC'}`;
    }
    if (kind === 'app_event') {
        const ev = a.definition?.trigger?.appEvent;
        if (ev) return `${ev.provider}.${ev.event}${a.lastStatus ? ` · ${a.lastStatus}` : ''}`;
        return `app event${a.lastStatus ? ` · ${a.lastStatus}` : ''}`;
    }
    if (kind === 'manual') return a.lastStatus ? `manual · ${a.lastStatus}` : 'manual';
    return kind;
}

function taskMeta(t) {
    const parts = [];
    if (t.repeatInterval) parts.push(t.repeatInterval);
    if (t.lastStatus) parts.push(t.lastStatus);
    return parts.join(' · ');
}
