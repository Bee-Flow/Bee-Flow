import type { StudioTemplate } from './types';

/**
 * The texts of a template card in the viewer's language.
 *
 * A built-in template (`source: 'builtin'`) has its title, description and category in the
 * namespace `studio_apps_templates_builtin`, keyed by the template id with underscores
 * (`app-sales-dashboard` → `app_sales_dashboard`) and the category by its name. The English there
 * is the template's own text, which is also the fallback, so a template without a key reads as it
 * always did. A template made from one of the organisation's own apps is shown as its author wrote it.
 */

const NS = 'studio_apps_templates_builtin';

type Translate = (key: string, fallback: string) => string;

/** `app-sales-dashboard` → `app_sales_dashboard`; `Dashboards` → `dashboards`. */
export function templateKeyPart(value: string): string {
    let out = '';
    for (const ch of value.toLowerCase()) {
        const word = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
        if (word) out += ch;
        else if (out && !out.endsWith('_')) out += '_';
    }
    return out.endsWith('_') ? out.slice(0, -1) : out;
}

export interface TemplateTexts { title: string; description: string; category: string }

export function templateTexts(tpl: StudioTemplate, t: Translate): TemplateTexts {
    const description = tpl.description || '';
    const category = tpl.category || '';
    if (tpl.source !== 'builtin') return { title: tpl.title, description, category };
    const id = templateKeyPart(tpl.id);
    return {
        title: t(`${NS}.${id}.title`, tpl.title),
        description: description ? t(`${NS}.${id}.description`, description) : '',
        category: category ? t(`${NS}.category.${templateKeyPart(category)}`, category) : '',
    };
}
