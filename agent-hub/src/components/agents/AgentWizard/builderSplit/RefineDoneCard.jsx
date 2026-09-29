import { FlaskConical, Undo2 } from 'lucide-react';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';

/**
 * De "Gedaan: …"-beurt van de verfijn-rail (A2 stap 5).
 *
 * De rail toonde na een verfijning de hele plankaart terug — naam, omschrijving,
 * capabilities — terwijl de editor ernaast diezelfde velden al bijgewerkt laat
 * zien. Wat er ontbrak was het enige dat de gebruiker níét kan zien: WELKE
 * velden de verfijning heeft aangeraakt. Dat is `changes`, de diff uit
 * `state/refineMerge.diffRefinedPlan`.
 *
 * Twee regels zitten in dit bestand, en ze zijn allebei het soort dat later
 * per ongeluk wordt omgedraaid:
 *
 *   EEN LEGE DIFF IS EEN ZIN, GEEN LEEG LIJSTJE. Een model dat de bestaande
 *   tekst terugkopieert levert nul wijzigingen op; "Gedaan" met niets eronder
 *   leest dan als "er is iets gebeurd dat ik je niet vertel".
 *
 *   ONGEDAAN MAKEN VERDWIJNT NOOIT STIL. De knop staat er ook als hij niet kán
 *   — zonder pre_refine-rij, of omdat er intussen een nieuwere verfijning
 *   overheen ging — en zegt dan wat eraan scheelt. Een knop die stil weggaat
 *   laat de gebruiker denken dat de verfijning definitief is; een knop die
 *   dóórdrukt zou een ANDER moment herstellen dan waar hij onder staat.
 *   Ongedaan maken gaat precies ÉÉN niveau diep: alleen de nieuwste beurt.
 */

/** De regel bij één wijziging — de vormkeuze is een SLEUTELkeuze, nooit een stringkeuze. */
function changeLabel(t, change) {
    const { field, direction, count } = change || {};
    if (!direction) {
        switch (field) {
            case 'systemPrompt': return t('agent_studio.refine.change_instructions', 'Rewrote the instructions');
            case 'name': return t('agent_studio.refine.change_name', 'Renamed the agent');
            case 'description': return t('agent_studio.refine.change_description', 'Updated the description');
            case 'avatar': return t('agent_studio.refine.change_avatar', 'Changed the avatar');
            case 'model': return t('agent_studio.refine.change_model', 'Changed the model');
            default: return null;
        }
    }
    if (field === 'apps') {
        return direction === 'added'
            ? nOf(t, 'agent_studio.refine.change_apps_added', count, 'Turned on {count} app', 'Turned on {count} apps')
            : nOf(t, 'agent_studio.refine.change_apps_removed', count, 'Turned off {count} app', 'Turned off {count} apps');
    }
    if (field === 'skills') {
        return direction === 'added'
            ? nOf(t, 'agent_studio.refine.change_skills_added', count, 'Attached {count} skill', 'Attached {count} skills')
            : nOf(t, 'agent_studio.refine.change_skills_removed', count, 'Detached {count} skill', 'Detached {count} skills');
    }
    if (field === 'knowledge') {
        return direction === 'added'
            ? nOf(t, 'agent_studio.refine.change_knowledge_added', count, 'Added {count} knowledge base', 'Added {count} knowledge bases')
            : nOf(t, 'agent_studio.refine.change_knowledge_removed', count, 'Removed {count} knowledge base', 'Removed {count} knowledge bases');
    }
    return null;
}

/**
 * De ongedaan-knop in vier toestanden. Drie ervan zijn "nee, en dit is waarom";
 * alleen `idle` doet iets.
 */
function undoStateOf({ undoVersionId, undoState, superseded }) {
    if (undoState === 'undone') return 'undone';
    if (undoState === 'busy') return 'busy';
    if (!undoVersionId) return 'unavailable';
    if (superseded) return 'superseded';
    return 'idle';
}

export default function RefineDoneCard({
    t,
    changes = [],
    undoVersionId = null,
    undoState = 'idle',
    superseded = false,
    onTest,
    onUndo,
}) {
    const lines = (Array.isArray(changes) ? changes : []).map(c => changeLabel(t, c)).filter(Boolean);
    const state = undoStateOf({ undoVersionId, undoState, superseded });
    const undoDisabled = state !== 'idle';
    const undoText = {
        idle: t('agent_studio.refine.undo', 'Undo'),
        busy: t('agent_studio.refine.undoing', 'Undoing…'),
        undone: t('agent_studio.refine.undone', 'Undone'),
        unavailable: t('agent_studio.refine.undo_unavailable', 'Undo unavailable — no restore point was saved'),
        superseded: t('agent_studio.refine.undo_superseded', 'Undo unavailable — a newer change came after this one'),
    }[state];

    return (
        <div
            data-testid="refine-done-card"
            className="rounded-2xl border px-4 py-3"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card, transparent)' }}
        >
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('agent_studio.refine.done_title', 'Done')}
            </div>

            {lines.length === 0 ? (
                // Nul wijzigingen is een uitkomst, geen lege lijst.
                <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }} data-testid="refine-done-nothing">
                    {t('agent_studio.refine.done_nothing', 'Nothing changed — the agent already worked that way.')}
                </p>
            ) : (
                <ul className="mt-1 space-y-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }} data-testid="refine-done-changes">
                    {lines.map((line, i) => (
                        <li key={i} className="flex gap-2">
                            <span aria-hidden="true">·</span>
                            <span>{line}</span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={onTest}
                    data-testid="refine-done-test"
                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                >
                    <FlaskConical size={13} aria-hidden="true" />
                    {t('agent_studio.refine.test_cta', 'Test with a question')}
                </button>
                <button
                    type="button"
                    onClick={() => { if (!undoDisabled) onUndo?.(undoVersionId); }}
                    disabled={undoDisabled}
                    data-testid="refine-done-undo"
                    data-undo-state={state}
                    title={undoText}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                >
                    <Undo2 size={13} aria-hidden="true" />
                    {undoText}
                </button>
            </div>

            {undoState === 'failed' && (
                <p className="mt-2 text-[12px]" style={{ color: 'var(--error)' }} data-testid="refine-done-undo-failed">
                    {t('agent_studio.refine.undo_failed', 'Undo failed — the agent was left as it is.')}
                </p>
            )}
        </div>
    );
}
