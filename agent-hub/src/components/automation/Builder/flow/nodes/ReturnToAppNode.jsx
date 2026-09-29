import { AppWindow } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase from './StepNodeBase';

/**
 * "Back to the app" — the run ends here and the Studio App is told what to do
 * next: which screen to open, what to say, what to refresh.
 *
 * TERMINAAL, en dat is wat deze kaart moet uitstralen. Net als StopErrorNode
 * geeft hij `onAddAfter` NIET door en zet hij `sourceConnectable={false}`: geen
 * "+"-knop, geen sleepbare uitgang. Dat weglaten is de hele regel — het
 * MECHANISME zit in StepNodeBase (`onAddAfter && …`, `isConnectable=
 * {sourceConnectable}`) en dat bestand noemt geen enkele stapsoort.
 *
 * Bestaande uitgaande randen (uit JSON/AI-authoring of uit een omgebouwde stap)
 * renderen nog wél en blijven verwijderbaar — alleen NIEUWE verbindingen worden
 * geweigerd, precies zoals bij Stop-and-Error.
 *
 * Geen `tone`: StepNodeBase kent er precies één (`error`, de rode eindkaart van
 * Stop-and-Error) en dit is juist de goede afloop van een routine die door een
 * knop werd gestart. De kaart draagt dus de gewone kleur van zijn familie
 * (`end`) — hem 'success' meegeven zou een prop zijn die nergens gelezen wordt.
 */
export default function ReturnToAppNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues } = data;
    // Wat er op de kaart staat is wat er GEBEURT als de run hier eindigt, in de
    // volgorde waarin de bezoeker het merkt: eerst de melding, dan het scherm.
    // De toast en het scherm-id zijn de woorden van de AUTEUR en blijven staan
    // zoals hij ze typte; alleen wat de kaart er zelf bij zegt gaat door t().
    const nav = step.navigateTo && typeof step.navigateTo === 'object' ? step.navigateTo : null;
    const parts = [];
    if (step.toast && step.toast.message) parts.push(String(step.toast.message));
    if (nav && nav.screenId) parts.push(`→ ${nav.screenId}`);
    if (step.refresh) {
        parts.push(step.refresh === 'resetForm'
            ? t('routines.node.return_to_app.card_resets_form', 'clears the form')
            : t('routines.node.return_to_app.card_reloads_data', 'reloads the data'));
    }
    const sub = parts.length
        ? parts.join(' · ')
        : { muted: t('routines.node.return_to_app.card_empty', 'tells the app nothing yet') };

    return (
        <StepNodeBase
            icon={<AppWindow size={14} />}
            typeLabel={nodeTypeLabel('return_to_app')}
            help={nodeHelp('return_to_app')}
            name={step.label || nodeDefaultLabel('return_to_app')}
            sub={sub}
            subTitle={parts.length ? parts.join(' · ') : undefined}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            sourceConnectable={false}
        />
    );
}
