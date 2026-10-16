import { useTranslation } from '../../../../../hooks/useTranslation';
import { FormRow, inputClass } from './formPrimitives';
import { CollectionArrayRefField } from './collectionEditors';
import type { RouteRule } from './routeEditorsModel';
import type { RouteConfig } from './routeTypes';

interface RouteAdvancedProps {
    route: RouteConfig;
    rules: RouteRule[];
    items: boolean;
    several: boolean;
    fanOut: boolean;
    groups: unknown;
    onFocusField: unknown;
    previewSample: unknown;
    onPatch: (patch: RouteConfig) => void;
    onChangeSource: (source: string) => void;
}

/** The Advanced section: everything the author does not normally touch (mode override, raw source path, fan-out, fallback, compiled expressions). */
export function RouteAdvancedFields({ route, rules, items, several, fanOut, groups, onFocusField, previewSample, onPatch, onChangeSource }: RouteAdvancedProps) {
    const { t } = useTranslation();
    // The generated expressions, shown under Advanced for the curious and for
    // support — the form itself never puts an expression on screen.
    const expressions = rules.map(r => r.expr).filter(Boolean);
    return (
        <>
            <FormRow label={t('automations.route_editors.deciding_about', 'Deciding about')} hint={t('automations.route_editors.detected_from_the_step_above_override', 'Detected from the step above — override it here if the guess is wrong.')}>
                <select
                    value={items ? 'items' : 'branch'}
                    onChange={(e) => onPatch(e.target.value === 'items' ? { mode: 'items' } : { mode: 'branch' })}
                    className={inputClass()}
                >
                    <option value="items">{t('automations.route_editors.each_item_of_a_list', 'Each item of a list')}</option>
                    <option value="branch">{t('automations.route_editors.the_whole_run', 'The whole run')}</option>
                </select>
            </FormRow>
            {items && (
                <CollectionArrayRefField
                    draft={{ arrayRef: route.source || '', maxItems: route.maxItems }}
                    set={(k: string, v: unknown) => (k === 'arrayRef' ? onChangeSource(typeof v === 'string' ? v : '') : onPatch({ maxItems: v }))}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            )}
            {/* The fan-out opt-in. It is a per-node CHOICE, never a
                migration: a stored router keeps first-match-wins until
                someone picks otherwise here, because flipping it for
                everyone would mean duplicate mails/tickets/API writes for
                customers who changed nothing (routeModel.js, writeRoute
                persists 'all' and CLEARS the key for 'first'). */}
            {several && (
                <FormRow
                    label={t('automations.route_editors.when_several_outputs_match', 'When several outputs match')}
                    hint={t('automations.route_editors.automations_built_before_this_existed_keep', 'Automations built before this existed keep sending each record down the first match only, until you change it here.')}
                >
                    <select
                        value={fanOut ? 'all' : 'first'}
                        onChange={(e) => onPatch({ matchMode: e.target.value === 'all' ? 'all' : 'first' })}
                        className={inputClass()}
                    >
                        <option value="all">{t('automations.route_editors.send_it_to_every_matching_output', 'Send it to every matching output')}</option>
                        <option value="first">{t('automations.route_editors.send_it_to_the_first_matching', 'Send it to the first matching output only')}</option>
                    </select>
                </FormRow>
            )}
            {rules.length > 1 && (
                <FormRow label={t('automations.route_editors.when_nothing_matches', 'When nothing matches')} hint={t('automations.route_editors.send_unmatched_values_to_one_of', 'Send unmatched values to one of your rules, or use the node\'s otherwise output.')}>
                    <select
                        value={route.defaultBranch || ''}
                        onChange={(e) => onPatch({ defaultBranch: e.target.value })}
                        className={inputClass()}
                    >
                        <option value="">{t('condition_node.otherwise.use', 'Use the Otherwise output')}</option>
                        {rules.filter(r => r.name).map(r => (
                            <option key={r.name} value={r.name}>{r.name}</option>
                        ))}
                    </select>
                </FormRow>
            )}
            {expressions.length > 0 && (
                <FormRow label={t('automations.route_editors.expression', 'Expression')} hint={t('automations.route_editors.what_the_rules_above_compile_to', 'What the rules above compile to. Read-only — edit the rules to change it.')}>
                    <div className="space-y-1">
                        {expressions.map((e, i) => (
                            <div key={i} className="text-[10px] font-mono text-[var(--text-tertiary)] break-all">{e}</div>
                        ))}
                    </div>
                </FormRow>
            )}
        </>
    );
}
