import { tryEvaluate } from '@shared/expr/engine.mjs';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppNode, ValidationRule } from '../../inspector/appDefinition';
import type { FormFieldMeta } from '../formContext';

/**
 * App Studio runtime — the field rules of a 'form' (AppForm.tsx): what each rule rejects and the
 * message it shows. Split from AppForm so the component file holds the state and the rendering.
 */

// ── node.validations (authored in the inspector's ValidationRuleEditor,
// canonicalized by server/appStudio/canonicalize.js) ────────────────────────
//
// Two rule vocabularies reach the runtime and both are honoured: the editor's
// (required · email · url · minLength · maxLength · min · max · pattern · expr)
// and the server validator's typed spelling of the same checks (format with
// format:'email'|'url', formula with expr).

/** The props of an input the form's validation reads. */
interface RuleProps {
    name?: string;
    min?: number;
    max?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Empty for validation: null/undefined, '' and an EMPTY ARRAY (multi-fields). */
function isEmptyValue(v: unknown) {
    if (v == null || v === '') return true;
    return Array.isArray(v) && v.length === 0;
}

function lengthOf(v: unknown) {
    return (Array.isArray(v) || typeof v === 'string') ? v.length : String(v).length;
}

function ruleKind(rule: ValidationRule | null | undefined) {
    if (rule?.type === 'format') return String(rule.format || '').toLowerCase();
    if (rule?.type === 'formula') return 'expr';
    return rule?.type;
}

function isUrl(v: unknown) {
    try { return !!new URL(String(v)).host; } catch { return false; }
}

/** True when the rule REJECTS this value. Never throws — a bad rule passes. */
function ruleFails(rule: ValidationRule, value: unknown, fieldScope: Record<string, unknown>) {
    const kind = ruleKind(rule);
    // An unchecked box is `false`, which is not "empty" by any of the tests
    // above — so a consent checkbox marked required submitted unticked, and the
    // one rule on the form that had to hold was the one that never fired.
    // Strictly `false`, so a required number of 0 and a required empty-ish
    // string keep the meanings they already had.
    if (kind === 'required') return isEmptyValue(value) || value === false;
    // Every other rule only bites on a filled field, so an optional field with
    // a format/bound rule stays optional.
    if (isEmptyValue(value)) return false;
    switch (kind) {
        case 'email': return !EMAIL_RE.test(String(value));
        case 'url': return !isUrl(value);
        case 'minLength': return Number.isFinite(Number(rule.value)) && lengthOf(value) < Number(rule.value);
        case 'maxLength': return Number.isFinite(Number(rule.value)) && lengthOf(value) > Number(rule.value);
        case 'min': return Number.isFinite(Number(value)) && Number(value) < Number(rule.value);
        case 'max': return Number.isFinite(Number(value)) && Number(value) > Number(rule.value);
        case 'pattern':
            // nosemgrep: ajinabraham.njsscan.dos.regex_injection.regex_injection_dos -- the app author's own validation pattern, run in the browser of the person filling the form; an invalid one is caught
            try { return !new RegExp(String(rule.value)).test(String(value)); } catch { return false; }
        case 'expr': {
            const expr = typeof rule.expr === 'string' ? rule.expr.trim() : '';
            if (!expr) return false;
            // Same read as the inspector's live preview and evalVisibility: an
            // expression that errors is falsy, so the rule rejects.
            return !tryEvaluate(expr, fieldScope).value;
        }
        default: return false;
    }
}

/** The author's message, or sensible copy generated from the rule itself. */
function ruleMessage(rule: ValidationRule, t: TranslateFn) {
    if (typeof rule?.message === 'string' && rule.message.trim()) return rule.message;
    switch (ruleKind(rule)) {
        case 'required': return t('studio_apps_runtime.form.required', 'This field is required.');
        case 'email': return t('studio_apps_runtime.form.invalid_email', 'Enter a valid email address.');
        case 'url': return t('studio_apps_runtime.form.invalid_url', 'Enter a valid URL.');
        case 'minLength': return t('studio_apps_runtime.form.min_length', 'Enter at least {n} characters.', { n: rule.value });
        case 'maxLength': return t('studio_apps_runtime.form.max_length', 'Enter at most {n} characters.', { n: rule.value });
        case 'min': return t('studio_apps_runtime.form.min', 'Enter {n} or more.', { n: rule.value });
        case 'max': return t('studio_apps_runtime.form.max', 'Enter {n} or less.', { n: rule.value });
        case 'pattern': return t('studio_apps_runtime.form.pattern', 'This value is not in the expected format.');
        default: return t('studio_apps_runtime.form.invalid', 'This value is not valid.');
    }
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

/**
 * One field's error message, or undefined when it passes. Shared by the submit
 * pass and by live validation (validateOn), so both read the same rules.
 */
export function fieldError(
    meta: FormFieldMeta | undefined,
    rules: ValidationRule[] | undefined,
    v: unknown,
    fieldScope: Record<string, unknown>,
    t: TranslateFn,
): string | undefined {
    // A field the author switched off (enabledWhen:false) is inert on
    // screen — validating it puts an error the user cannot clear under
    // a control they cannot focus, and the form can never be sent.
    if (!meta || meta.disabled) return undefined;
    // The browser refused what was typed (a number box holding "12e"
    // reports '' while still showing the text). The input says so on
    // screen; without this the form did not, so an optional field
    // submitted EMPTY under a visible "Enter a number".
    if (meta.invalid) return meta.invalidMessage || t('studio_apps_runtime.form.invalid', 'This value is not valid.');
    if (meta.required && isEmptyValue(v)) return t('studio_apps_runtime.form.required', 'This field is required.');
    for (const rule of rules || []) {
        if (ruleFails(rule, v, fieldScope)) return ruleMessage(rule, t);
    }
    return undefined;
}
