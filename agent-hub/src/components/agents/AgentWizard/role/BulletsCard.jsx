import { Ban, CheckCircle2, Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import { PERSONA_LIMITS } from './personaFacts';
import RoleCard, { RoleEmpty, RoleNote } from './RoleCard';

/**
 * "Doet wel" en "Doet niet" — twee bulletlijsten van dezelfde vorm
 * (Agents-artboard 1c). Eén component, want ze verschillen alleen in glyph,
 * titel en in de regel eronder — en juist die regel is het hele punt.
 *
 * ── "DOET NIET" IS EEN BELOFTE, EN NIEMAND DWINGT HEM AF ────────────
 * Gemeten, niet aangenomen: `doesNot` komt in de hele codebase precies één
 * keer voor buiten zijn eigen normalisatie, namelijk in
 * `renderSystemPrompt` (server/core/agentRuntime/personaPrompt.js), waar het
 * een blok "What you never do:" in het systeemprompt wordt. Verder niets. Geen
 * guardrail leest het (`core/agentRuntime/guardrailsRunner.js` kent alleen
 * unicode-smokkel, PII en de regex-patronen van het Privacy Shield), geen
 * toolpoort kijkt ernaar (`toolPolicy.js` beslist op `config.tools`), en er is
 * geen uitvoerfilter. Ook `strictKnowledge` — de buurman-instelling — is
 * enkel een preambule in datzelfde prompt (`contextBuilder.js:216`).
 *
 * Een regel hier is dus een INSTRUCTIE aan het model, geen blokkade. Dat mag
 * niet impliciet blijven: de gebruiker die "Nooit korting toezeggen" opschrijft
 * denkt een grens te hebben getrokken, en heeft een verzoek gedaan. Wat wél
 * hard is, is wat de agent nooit gekregen heeft — een app, tabel of automatisering die
 * niet in `config.tools` staat wordt niet eens aangeboden, en een grant op
 * `{confirm:'ask'}` houdt de actie tegen tot een mens ja zegt. Daar wijst de
 * regel onder de kaart naartoe.
 *
 * ── DE SERVER GOOIT STIL WEG, DEZE KAART NIET ───────────────────────
 * `_list` in personaPrompt.js ontdubbelt hoofdletter-ongevoelig en stopt bij
 * twintig. Alle drie de afwijzingen (leeg, dubbel, vol) komen daarom hier op
 * het scherm vóór de opslag, in plaats van als een regel die zomaar niet
 * verschijnt.
 */

/** De afwijzingsreden als zin. Letterlijke t()-aanroepen voor de i18n-guard. */
function rejectionMessage(t, code) {
    if (code === 'duplicate') return t('agent_studio.role.bullet_duplicate', 'That line is already in this list.');
    if (code === 'full') return t('agent_studio.role.bullet_full', 'Twenty lines is the maximum this agent keeps — anything beyond that is dropped when it saves.');
    return null;
}

/**
 * Eén regel: klikken bewerkt hem, leeg opslaan verwijdert hem.
 *
 * BEWERKEN KAN OOK AFGEWEZEN WORDEN. Een regel bewerken naar iets dat al in de
 * lijst staat leverde twee regels in en één regel uit — de bewerkte regel was
 * weg, zonder één woord op het scherm. `editBullet` geeft daar nu
 * `'duplicate'` op terug, en dan blijft het invoerveld staan mét de reden
 * eronder; precies wat `AddRow` hieronder al deed.
 */
function BulletRow({ t, text, index, onEdit, onRemove, readOnly }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(text);
    const [rejected, setRejected] = useState(null);
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
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
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
function AddRow({ t, onAdd }) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [rejected, setRejected] = useState(null);

    const commit = () => {
        const code = onAdd?.(draft) ?? null;
        setRejected(code);
        if (!code) { setDraft(''); setOpen(false); }
        // Leeg is geen fout maar een afgebroken invoer: dicht, zonder melding.
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
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
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

export default function BulletsCard({ t, variant, items = [], onAdd, onEdit, onRemove, readOnly = false }) {
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
