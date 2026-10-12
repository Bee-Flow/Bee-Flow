// "Back to the app" — de editor van de tweede terminale stap (P4).
//
// ── WAT DIT SCHERM EERLIJK MOET ZIJN ────────────────────────────────────────
//  1. HET SCHERM-ID IS EEN ID, GEEN LIJST. De automation-editor kent de app niet:
//     hij weet niet welke Studio App deze automatisering straks aanroept, laat staan
//     welke schermen die heeft (er kunnen er meerdere zijn). Dus een tekstveld
//     met het id, en dat wordt ook zo GEZEGD — een keuzelijst die maar één app
//     kent, zou liegen zodra een tweede knop dezelfde automatisering aanroept.
//  2. NIETS INVULLEN IS NIETS DOEN. Een leeg veld schrijft `null`, niet een
//     leeg object: zie writeStepPatch in formState.js. De validator zou een
//     `{ screenId: '' }` als een ONAF scherm lezen terwijl de auteur juist zei
//     dat er niet genavigeerd hoeft te worden.
//  3. DE TERUGVAL STAAT IN ADVANCED, MET EEN VEILIGE DEFAULT. "Blijf staan waar
//     je bent" is het versmallende antwoord als de terugkeer niet uitvoerbaar
//     is; het foutscherm is de bewuste keuze.
import React from 'react';
import { FormRow, inputClass } from './formPrimitives';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SegmentedControl from '../../../../shared/SegmentedControl';
import TemplateField from '../../mapping/TemplateField';
import AccordionSection from '../AccordionSection';

/** Tone vocabulary — mirrors RETURN_TO_APP_TOAST_TONES on the server. */
const TONES = ['info', 'success', 'warning', 'danger'];
/** Refresh vocabulary — mirrors RETURN_TO_APP_REFRESH_MODES on the server. */
const REFRESH_MODES = ['tableViews', 'resetForm'];

export default function ReturnToAppFields({
    draft, set, onFocusField, previewSample, errorSections = new Set(),
}) {
    const { t } = useTranslation();
    const toneOptions = [
        { value: 'info', label: t('automation_editor.return_to_app.tone_info', 'Info') },
        { value: 'success', label: t('automation_editor.return_to_app.tone_success', 'Success') },
        { value: 'warning', label: t('automation_editor.return_to_app.tone_warning', 'Warning') },
        { value: 'danger', label: t('automation_editor.return_to_app.tone_danger', 'Problem') },
    ];

    return (
        <>
            <AccordionSection
                stepType="return_to_app"
                sectionKey="config"
                title={t('automation_editor.return_to_app.section_config', 'What the app does next')}
                defaultOpen
                forceOpen={errorSections.has('config')}
            >
                <FormRow
                    label={t('automation_editor.return_to_app.toast_label', 'Message to show')}
                    hint={t('automation_editor.return_to_app.toast_hint', 'A single line the visitor reads when the automation finishes. Template-interpolated.')}
                >
                    <TemplateField
                        value={draft.toastMessage || ''}
                        onChange={(next) => set('toastMessage', next)}
                        rows={2}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={t('automations.return_to_app_editor.saved', 'Saved {{steps.save.output.name}}')}
                    />
                </FormRow>
                {draft.toastMessage ? (
                    <FormRow label={t('automation_editor.return_to_app.tone_label', 'Tone')}>
                        <SegmentedControl
                            value={TONES.includes(draft.toastTone) ? draft.toastTone : 'info'}
                            onChange={(tone) => set('toastTone', tone)}
                            options={toneOptions}
                            size="sm"
                            fullWidth
                            ariaLabel={t('automation_editor.return_to_app.tone_label', 'Tone')}
                        />
                    </FormRow>
                ) : null}
                <FormRow
                    label={t('automation_editor.return_to_app.screen_label', 'Screen to open')}
                    hint={t('automation_editor.return_to_app.screen_hint', 'The id of a screen in the app that starts this automation. Leave empty to stay where the visitor is.')}
                >
                    <input
                        type="text"
                        className={inputClass()}
                        value={draft.navigateScreenId || ''}
                        onChange={(e) => set('navigateScreenId', e.target.value)}
                        placeholder="scr_orders"
                        aria-label={t('automation_editor.return_to_app.screen_label', 'Screen to open')}
                    />
                </FormRow>
                {draft.navigateScreenId ? (
                    <FormRow
                        label={t('automation_editor.return_to_app.record_label', 'Record to open')}
                        hint={t('automation_editor.return_to_app.record_hint', 'The id the screen should show. Reaches it as screen.params.id.')}
                    >
                        <TemplateField
                            value={draft.navigateRecordRef || ''}
                            onChange={(next) => set('navigateRecordRef', next)}
                            rows={1}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            placeholder="{{steps.save.output.id}}"
                        />
                    </FormRow>
                ) : null}
                <FormRow
                    label={t('automation_editor.return_to_app.refresh_label', 'Refresh')}
                    hint={t('automation_editor.return_to_app.refresh_hint', 'What the app reloads once the run is done.')}
                >
                    <select
                        className={inputClass()}
                        value={REFRESH_MODES.includes(draft.refresh) ? draft.refresh : ''}
                        onChange={(e) => set('refresh', e.target.value)}
                        aria-label={t('automation_editor.return_to_app.refresh_label', 'Refresh')}
                    >
                        <option value="">{t('automation_editor.return_to_app.refresh_none', 'Nothing')}</option>
                        <option value="tableViews">{t('automation_editor.return_to_app.refresh_tables', 'Reload the data on screen')}</option>
                        <option value="resetForm">{t('automation_editor.return_to_app.refresh_form', 'Clear the form that started this')}</option>
                    </select>
                </FormRow>
            </AccordionSection>
            <AccordionSection
                stepType="return_to_app"
                sectionKey="advanced"
                title={t('automation_editor.return_to_app.section_advanced', 'Advanced')}
                forceOpen={errorSections.has('advanced')}
            >
                <FormRow
                    label={t('automation_editor.return_to_app.on_error_label', 'If the app cannot do this')}
                    hint={t('automation_editor.return_to_app.on_error_hint', 'When the screen no longer exists, or there is no form to clear. Staying put is the safe answer.')}
                >
                    <select
                        className={inputClass()}
                        value={draft.onError === 'errorScreen' ? 'errorScreen' : 'stay'}
                        onChange={(e) => set('onError', e.target.value)}
                        aria-label={t('automation_editor.return_to_app.on_error_label', 'If the app cannot do this')}
                    >
                        <option value="stay">{t('automation_editor.return_to_app.on_error_stay', 'Stay on the current screen')}</option>
                        <option value="errorScreen">{t('automation_editor.return_to_app.on_error_screen', 'Show the app’s error screen')}</option>
                    </select>
                </FormRow>
            </AccordionSection>
        </>
    );
}
