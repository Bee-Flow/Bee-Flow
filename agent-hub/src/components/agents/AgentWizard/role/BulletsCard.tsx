import { Ban, CheckCircle2, Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import { PERSONA_LIMITS, type BulletRejection } from './personaFacts';
import RoleCard, { RoleEmpty, RoleNote } from './RoleCard';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * "Does" and "Does not": two bullet lists of the same shape (Agents artboard 1c). One component, because they differ only in
 * glyph, title and the line underneath, and precisely that line is the whole point.
 *
 * ── "DOES NOT" IS A PROMISE, AND NOBODY ENFORCES IT ───────────────
 * Measured, not assumed: `doesNot` occurs in the whole codebase exactly once outside its own normalisation, namely in
 * `renderSystemPrompt` (server/core/agentRuntime/personaPrompt.js), where it becomes a block "What you never do:" in the
 * system prompt. Nothing else. No guardrail reads it (`core/agentRuntime/guardrailsRunner.js` knows only unicode smuggling,
 * PII and the regex patterns of the Privacy Shield), no tool gate looks at it (`toolPolicy.js` decides on `config.tools`),
 * and there is no output filter. `strictKnowledge`, the neighbouring setting, is merely a preamble in that same prompt
 * (`contextBuilder.js:216`).
 *
 * A rule here is therefore an INSTRUCTION to the model, not a block. That may not stay implicit: the user who writes
 * "Never grant discounts" thinks they have drawn a boundary, and has in fact made a request. What IS hard is what the
 * agent never received: an app, table or automation that is not in `config.tools` is not even offered, and a grant on
 * `{confirm:'ask'}` holds the action back until a human says yes. The line under the card points to that.
 *
 * ── THE SERVER SILENTLY DISCARDS, THIS CARD DOES NOT ───────────────
 * `_list` in personaPrompt.js de-duplicates case-insensitively and stops at twenty. All three rejections (empty, duplicate,
 * full) therefore come up here on the screen before saving, instead of as a rule that simply does not appear.
 */

/** De afwijzingsreden als zin. Letterlijke t()-aanroepen voor de i18n-guard. */
function rejectionMessage(t: TranslateFn, code: BulletRejection) {
    if (code === 'duplicate') return t('agent_studio.role.bullet_duplicate', 'That line is already in this list.');
    if (code === 'full') return t('agent_studio.role.bullet_full', 'Twenty lines is the maximum this agent keeps — anything beyond that is dropped when it saves.');
    return null;
}

/**
 * One rule: clicking edits it, saving empty removes it.
 *
 * EDITING CAN ALSO BE REJECTED. Editing a rule to something that is already in the list let two rules in and one out: the
 * edited rule was gone, without a single word on the screen. `editBullet` now returns `'duplicate'` for that, and then the
 * input field stays in place with the reason under it, exactly what `AddRow` below already did.
 */
function BulletRow({ t, text, index, onEdit, onRemove, readOnly }: {
    t: TranslateFn;
    text: string;
    index: number;
    onEdit?: (index: number, value: string) => BulletRejection;
    onRemove?: (index: number) => void;
    readOnly: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(text);
    const [rejected, setRejected] = useState<BulletRejection>(null);
    const commit = () => {
        if (draft === text) { setEditing(false); setRejected(null); return; }
        const code = onEdit?.(index, draft) ?? null;
        setRejected(code);
        if (!code) setEditing(false);
    };
    const start = () => { setDraft(text); setRejected(null); setEditing(true); };

    return (
        <div data-testid="agent-role-bullet" className="flex flex-col gap-1">
        <div className="flex items-start gap-2 text-[12px] leading-[17px] text-[var(--text-secondary)]">
            <span className="text-[var(--text-tertiary)] leading-[17px]" aria-hidden="true">&bull;</span>
            {editing && !readOnly ? (
                <input
                    autoFocus
                    data-testid="agent-role-bullet-input"
                    aria-label={t('agent_studio.role.bullet_edit_label', 'Edit this line')}
                    value={draft}
                    maxLength={PERSONA_LIMITS.bullet}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === 'Enter') { e.preventDefault(); commit(); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setDraft(text); }
                    }}
                    className="flex-1 min-w-0 bg-[var(--bg-secondary)]/60 rounded px-1.5 py-0.5 outline-none border border-[var(--border-default)] text-[12px]"
                />
            ) : (
                <span className="flex-1 min-w-0">
                    {readOnly ? text : (
                        <button
                            type="button"
                            onClick={start}
                            data-testid="agent-role-bullet-text"
                            className="text-left hover:underline"
                        >{text}</button>
                    )}
                </span>
            )}
            {!readOnly && !editing && (
                <button
                    type="button"
                    data-testid="agent-role-bullet-remove"
                    aria-label={t('agent_studio.role.bullet_remove', 'Remove this line')}
                    onClick={() => onRemove?.(index)}
                    className="flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--warning)]"
                ><X size={12} aria-hidden="true" /></button>
            )}
        </div>
        {rejectionMessage(t, rejected) && (
            <RoleNote tone="warn" testId="agent-role-bullet-edit-rejected">{rejectionMessage(t, rejected)}</RoleNote>
        )}
        </div>
    );
}

/** De "+ toevoegen"-regel; klikken maakt er een invoerveld van. */
function AddRow({ t, onAdd }: { t: TranslateFn; onAdd?: (value: string) => BulletRejection }) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [rejected, setRejected] = useState<BulletRejection>(null);

    const commit = () => {
        const code = onAdd?.(draft) ?? null;
        setRejected(code);
        if (!code) { setDraft(''); setOpen(false); }
        // Empty is not an error but an interrupted input: closed, without a message.
        if (code === 'empty') { setDraft(''); setOpen(false); setRejected(null); }
    };

    if (!open) {
        return (
            <button
                type="button"
                data-testid="agent-role-bullet-add"
                onClick={() => { setOpen(true); setRejected(null); }}
                className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
                <Plus size={12} aria-hidden="true" />
                {t('agent_studio.role.bullet_add', 'add')}
            </button>
        );
    }
    return (
        <div className="flex flex-col gap-1">
            <input
                autoFocus
                data-testid="agent-role-bullet-add-input"
                aria-label={t('agent_studio.role.bullet_add_label', 'Add a line')}
                value={draft}
                maxLength={PERSONA_LIMITS.bullet}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') { e.preventDefault(); commit(); }
                    if (e.key === 'Escape') { e.preventDefault(); setDraft(''); setOpen(false); setRejected(null); }
                }}
                className="bg-[var(--bg-secondary)]/60 rounded px-1.5 py-0.5 outline-none border border-[var(--border-default)] text-[12px]"
            />
            {rejectionMessage(t, rejected) && (
                <RoleNote tone="warn" testId="agent-role-bullet-rejected">{rejectionMessage(t, rejected)}</RoleNote>
            )}
        </div>
    );
}

export default function BulletsCard({ t, variant, items = [], onAdd, onEdit, onRemove, readOnly = false }: {
    t: TranslateFn;
    variant: 'does' | 'doesNot';
    items?: string[];
    onAdd?: (value: string) => BulletRejection;
    onEdit?: (index: number, value: string) => BulletRejection;
    onRemove?: (index: number) => void;
    readOnly?: boolean;
}) {
    const forbids = variant === 'doesNot';
    return (
        <RoleCard
            testId={forbids ? 'agent-role-does-not' : 'agent-role-does'}
            icon={forbids ? <Ban size={14} /> : <CheckCircle2 size={14} />}
            iconColor={forbids ? 'var(--error)' : 'var(--success)'}
            title={forbids
                ? t('agent_studio.role.does_not_title', 'Never does')
                : t('agent_studio.role.does_title', 'Does')}
        >
            <div className="flex flex-col gap-1.5">
                {items.map((text, i) => (
                    <BulletRow
                        key={`${i}-${text}`}
                        t={t} text={text} index={i}
                        onEdit={onEdit} onRemove={onRemove} readOnly={readOnly}
                    />
                ))}
                {items.length === 0 && (
                    <RoleEmpty testId={forbids ? 'agent-role-does-not-empty' : 'agent-role-does-empty'}>
                        {forbids
                            ? t('agent_studio.role.does_not_empty', 'No limits written down yet.')
                            : t('agent_studio.role.does_empty', 'Nothing listed yet.')}
                    </RoleEmpty>
                )}
                {!readOnly && <AddRow t={t} onAdd={onAdd} />}
            </div>

            {(items.length > 0 || !readOnly) && (
                forbids ? (
                    <RoleNote testId="agent-role-does-not-note">
                        {t('agent_studio.role.does_not_note', 'These lines go into the instructions and the model follows them — nothing here blocks the action. What an agent truly cannot do is what it was never given: take the app, table or automation away under "Can use", or set it to ask first.')}
                    </RoleNote>
                ) : (
                    <RoleNote testId="agent-role-does-note">
                        {t('agent_studio.role.does_note', 'A line here says what the agent should do. It does not hand it the app, table or automation to do it — that happens under "Can use".')}
                    </RoleNote>
                )
            )}
        </RoleCard>
    );
}
