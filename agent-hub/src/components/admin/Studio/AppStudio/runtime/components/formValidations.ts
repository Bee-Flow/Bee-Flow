import type { AppNode, ValidationRule } from '../../inspector/appDefinition';

/**
 * Which rules each field of a form carries (split out of AppForm.tsx): the ones
 * the author wrote into `node.validations`, after the ones its props imply.
 */

/** The props of an input the form's validation reads. */
interface RuleProps {
    name?: string;
    min?: number;
    max?: number;
}

/**
 * The rules a component's own PROPS imply.
 *
 * `input_number` advertises min/max in the spec and passed them to the DOM only
 * — and the form renders with `noValidate`, so the browser never enforced them
 * either. A field documented as "1 to 10" happily submitted 500. These are
 * spelled as ordinary rules so they run through exactly the same machinery (and
 * message copy) as an authored one.
 */
function propRules(node: AppNode<RuleProps> | null | undefined) {
    if (node?.type !== 'input_number') return null;
    const out: ValidationRule[] = [];
    const { min, max } = node.props || {};
    if (Number.isFinite(min)) out.push({ type: 'min', value: min });
    if (Number.isFinite(max)) out.push({ type: 'max', value: max });
    return out.length ? out : null;
}

/**
 * Deep-walk the form's child DEFINITIONS → Map(fieldName → rules). Deep,
 * because inputs may sit inside a container inside the form; only registered
 * (i.e. mounted) names are validated, so a hidden field's rules stay inert.
 *
 * Prop-implied rules come first so an authored rule with the same bound (and a
 * hand-written message) is the one the user sees.
 */
export function collectValidations(node: Pick<AppNode, 'children'>) {
    const out = new Map<string, ValidationRule[]>();
    const visit = (n: AppNode<RuleProps> | null | undefined) => {
        if (!n || typeof n !== 'object') return;
        const fieldName = n.props?.name;
        if (fieldName) {
            const authored = Array.isArray(n.validations) ? n.validations : [];
            const implied = propRules(n) || [];
            if (authored.length || implied.length) out.set(fieldName, [...implied, ...authored]);
        }
        for (const child of (Array.isArray(n.children) ? n.children : [])) visit(child);
    };
    for (const child of (Array.isArray(node.children) ? node.children : [])) visit(child);
    return out;
}
