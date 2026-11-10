import ActionPicker from '../ActionPicker';
import { updateNodeProps } from '../../state/definitionOps';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { RepeatableList, inputCls } from '@/components/admin/product-website/fields';
import { INPUT_CLS } from './kit';
import type { AppDefinition, AppNode } from '../appDefinition';

/** The tones the spec allows on a toolbar or bulk button (COLOR_ROLES in componentSpecs/styleKnobs.js). */
const TONES = ['neutral', 'primary', 'success', 'warning', 'danger', 'info'] as const;

interface SurfaceButton {
    label?: string;
    actionId?: string;
    tone?: string;
}

interface GridActionSurfacesProps {
    node: AppNode;
    definition: AppDefinition;
    onCommit: (next: AppDefinition) => void;
    disabled?: boolean;
}

const patchProps = (def: AppDefinition, node: AppNode, patch: Record<string, unknown>) => (
    updateNodeProps(def, node.id, patch) as AppDefinition
);

function ButtonList({ prop, label, addLabel, node, definition, onCommit, disabled }: GridActionSurfacesProps & {
    prop: 'toolbarActions' | 'bulkActions';
    label: string;
    addLabel: string;
}) {
    const { t } = useTranslation();
    const items = ((node.props || {})[prop] as SurfaceButton[] | undefined) || [];
    // Both lists hold at most four buttons (maxItems in the data_grid spec).
    const withItem = (idx: number, next: SurfaceButton, def: AppDefinition) => (
        patchProps(def, node, { [prop]: items.map((it, i) => (i === idx ? next : it)) })
    );
    return (
        <fieldset disabled={disabled} className="min-w-0">
            <RepeatableList<SurfaceButton>
                label={label}
                items={items}
                maxItems={4}
                onChange={(next) => onCommit(patchProps(definition, node, { [prop]: next }))}
                makeNew={() => ({ label: '', actionId: '' })}
                addLabel={addLabel}
                itemLabel={(a) => a.label}
                renderItem={(a, update, idx) => (
                    <div className="flex flex-col gap-2">
                        <input
                            type="text"
                            className={inputCls}
                            value={a.label || ''}
                            onChange={(e) => update({ ...a, label: e.target.value })}
                            placeholder={t('studio_apps_panels.common.button_label', 'Button label')}
                        />
                        <select
                            className={INPUT_CLS}
                            value={a.tone || 'neutral'}
                            onChange={(e) => update({ ...a, tone: e.target.value })}
                            aria-label={t('studio_apps_surfaces.tone', 'Button tone')}
                        >
                            {TONES.map((tone) => (
                                <option key={tone} value={tone}>{t(`studio_apps_surfaces.tone_${tone}`, tone)}</option>
                            ))}
                        </select>
                        <ActionPicker
                            value={a.actionId}
                            definition={definition}
                            node={node}
                            disabled={disabled}
                            ariaLabel={label}
                            onPick={(actionId, def) => onCommit(withItem(idx, { ...a, actionId }, def))}
                            onEditDefinition={onCommit}
                        />
                    </div>
                )}
            />
        </fieldset>
    );
}

/**
 * The table's toolbar buttons, the buttons on the selection and the "add a row" line: the three action
 * surfaces of data_grid that had no control (only the AI could set them). The prop shapes are the spec's own
 * (`toolbarActions` / `bulkActions`: label, actionId, tone; `addRowLabel`, `addRowActionId`).
 */
export default function GridActionSurfaces(props: GridActionSurfacesProps) {
    const { t } = useTranslation();
    const { node, definition, onCommit, disabled = false } = props;
    const p = (node.props || {}) as { addRowLabel?: string; addRowActionId?: string; selectable?: string };
    return (
        <>
            <ButtonList
                {...props}
                prop="toolbarActions"
                label={t('studio_apps_surfaces.toolbar_actions', 'Toolbar buttons')}
                addLabel={t('studio_apps_surfaces.add_toolbar_action', 'Add toolbar button')}
            />
            <ButtonList
                {...props}
                prop="bulkActions"
                label={t('studio_apps_surfaces.bulk_actions', 'Actions on selected rows')}
                addLabel={t('studio_apps_surfaces.add_bulk_action', 'Add action on selected rows')}
            />
            {p.selectable !== 'multi' && p.selectable !== 'single' && ((node.props || {}).bulkActions as unknown[] | undefined)?.length ? (
                <p className="text-[11px] text-[var(--text-tertiary)]">
                    {t('studio_apps_surfaces.bulk_needs_selection', 'These buttons only show once rows can be selected. Set Selection to Single or Multi.')}
                </p>
            ) : null}
            <FormField label={t('studio_apps_surfaces.add_row', '“Add a row” line')}>
                <div className="flex flex-col gap-2">
                    <input
                        type="text"
                        className={inputCls}
                        value={p.addRowLabel || ''}
                        onChange={(e) => onCommit(patchProps(definition, node, { addRowLabel: e.target.value || undefined }))}
                        placeholder={t('studio_apps_surfaces.add_row_label', 'Label, for example Add a row')}
                        disabled={disabled}
                    />
                    <ActionPicker
                        value={p.addRowActionId}
                        definition={definition}
                        node={node}
                        disabled={disabled}
                        ariaLabel={t('studio_apps_surfaces.add_row_action', 'Action for the add-row line')}
                        onPick={(actionId, def) => onCommit(patchProps(def, node, { addRowActionId: actionId }))}
                        onEditDefinition={onCommit}
                    />
                </div>
            </FormField>
        </>
    );
}
