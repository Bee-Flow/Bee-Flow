import React from 'react';
import { CARD_COPY, KIND_OPTIONS, PRIMARY_KINDS, kindLabel } from './actionKindCatalog';
import { INPUT_CLS } from './panels/kit';
import useTranslation from '../../../../../hooks/useTranslation';
import ChoiceCards from '../../../../shared/ChoiceCards';
import Disclosure from '../../../../shared/Disclosure';

/**
 * "When clicked" — the four things a button usually does, as cards.
 *
 * It was one `<select>` with eleven equally-weighted options, ordered by the
 * schema. Nothing was recommended, nothing was explained, and "AI · extract
 * from document" sat next to "Show a message" as though the two were comparable
 * choices. The redesign privileges four and keeps the rest one click away —
 * OFFERED, not hidden, because a kind the editor does not offer is a kind only
 * the AI builder can write.
 *
 * ── Why the select stays ───────────────────────────────────────────────────
 * "All options" holds the same `<select aria-label="Action kind">` it always
 * did. Rewriting that into a second card grid would have meant reproducing
 * eleven editors' worth of affordances; keeping it means every existing
 * behaviour (and the tests that pin it) still works, one disclosure deeper.
 *
 * ── The honest case: the action is none of the four ────────────────────────
 * A `send_email` action has no card. Rendering the card group with nothing
 * checked and saying no more would leave the author looking at four unselected
 * options for an action that IS something. So the current kind is named
 * explicitly and the disclosure starts OPEN — the truth is one glance away
 * rather than one click.
 */

export default function ActionChoiceCards({
    kind, onPickKind, disabled = false, children,
}) {
    const { t } = useTranslation();
    const isPrimary = PRIMARY_KINDS.includes(kind);
    const current = kindLabel(kind);

    const options = PRIMARY_KINDS.map((k) => ({
        value: k,
        label: t(CARD_COPY[k].labelKey, CARD_COPY[k].labelEn),
        description: t(CARD_COPY[k].blurbKey, CARD_COPY[k].blurbEn),
    }));

    return (
        <div className="flex flex-col gap-2.5">
            <ChoiceCards
                value={isPrimary ? kind : null}
                onChange={onPickKind}
                options={options}
                ariaLabel={t('app_studio.inspector.what_happens', 'What happens')}
                disabled={disabled}
                columns={2}
            />

            {!isPrimary ? (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {current
                        ? t('app_studio.inspector.kind_is_other', 'Right now this does something else: {name}.', {
                            name: t(current.labelKey, current.labelEn),
                        })
                        // A kind with no entry in the catalog is a kind this
                        // build does not know. Say the raw name rather than
                        // pretending one of the four is selected.
                        : t('app_studio.inspector.kind_is_unknown', 'Right now this is set to “{kind}”, which this version does not know.', { kind: String(kind || '') })}
                </p>
            ) : null}

            <Disclosure
                title={t('app_studio.inspector.all_options', 'All options')}
                defaultOpen={!isPrimary}
            >
                <div className="flex flex-col gap-3">
                    <select
                        className={INPUT_CLS}
                        // The select shows the action's OWN kind, always — there
                        // is an option for it below whatever it is. The old code
                        // fell back to 'run_automation' for anything it did not
                        // list, so a kind from a newer build displayed as "Run
                        // automation" and the first change replaced the whole
                        // action. Claiming something is an automation is worse than
                        // showing a name the reader does not recognise.
                        value={kind || 'run_automation'}
                        onChange={(e) => onPickKind(e.target.value)}
                        disabled={disabled}
                        aria-label={t('app_studio.inspector.kind_aria', 'Action kind')}
                    >
                        {KIND_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{t(o.labelKey, o.labelEn)}</option>
                        ))}
                        {/* A kind the catalog does not list still has to show
                            its own name, or the select claims the action is
                            something it is not. */}
                        {kind && !KIND_OPTIONS.some((o) => o.value === kind) ? (
                            <option value={kind}>{String(kind).replace(/_/g, ' ')}</option>
                        ) : null}
                    </select>
                    {children}
                </div>
            </Disclosure>
        </div>
    );
}
