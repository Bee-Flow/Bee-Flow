import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { TextField } from './panels/kit';
import { CSS_CLASS_MAX, isCssClassName } from '../runtime/appCss';
import { deepClone, findNode } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';

/**
 * The CSS class of one component (`node.cssClass`): a name of the author's own, rendered as
 * `u-<name>` on the component's cell for the app's stylesheet (design.customCss).
 *
 * What is typed is committed only while it is a valid name; an empty field removes the key.
 * A name that is not valid yet stays in the field with the rule under it, and the stored
 * value keeps what it was.
 */

/** The definition with `nodeId`'s cssClass set, or removed for an empty name. */
export function setNodeCssClass(definition: AppDefinition, nodeId: string, name: string): AppDefinition {
    const next = deepClone(definition);
    const node = findNode(next, nodeId)?.node as AppNode | undefined;
    if (!node) return definition;
    if (name) node.cssClass = name;
    else delete node.cssClass;
    return next;
}

interface Props {
    definition: AppDefinition;
    node: AppNode;
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
}

export default function CssClassField({ definition, node, onCommit, disabled }: Props) {
    const { t } = useTranslation();
    const stored = typeof node.cssClass === 'string' ? node.cssClass : '';
    const [draft, setDraft] = useState(stored);
    useAdjustOnChange([node.id, stored] as const, () => setDraft(stored));
    const invalid = draft !== '' && !isCssClassName(draft);

    const change = (text: string) => {
        setDraft(text);
        if (text !== stored && (text === '' || isCssClassName(text))) onCommit(setNodeCssClass(definition, node.id, text));
    };

    return (
        <div className="mt-4" data-testid="app-css-class-field">
            <TextField
                label={t('studio_apps_css.class_label', 'CSS class')}
                value={draft}
                onChange={change}
                placeholder={t('studio_apps_css.class_placeholder', 'hero')}
                disabled={disabled}
                hint={invalid
                    ? t('studio_apps_css.class_invalid', 'Start with a lower-case letter, then lower-case letters, digits or dashes (at most {max}).', { max: CSS_CLASS_MAX })
                    : t('studio_apps_css.class_hint', "A name of your own. Style it as .u-{name} in the app's custom CSS.", { name: draft || t('studio_apps_css.class_placeholder', 'hero') })}
            />
        </div>
    );
}
