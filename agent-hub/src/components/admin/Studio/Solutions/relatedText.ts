import type { RelatedPart } from './relatedParts';
import type { useTranslation } from '../../../../hooks/useTranslation';

/** The words for a related part: why it is needed, and why it cannot come along. */

type Translate = ReturnType<typeof useTranslation>['t'];

/** The sentence for a relation code; `{name}` is the part that needs it. */
function reasonOf(t: Translate, relation: string | null, name: string): string {
    switch (relation) {
        case 'runs': return t('solutions.rel_runs', 'Run by {name}', { name });
        case 'calls': return t('solutions.rel_calls', 'Called as a step by {name}', { name });
        case 'reads_table': return t('solutions.rel_reads_table', 'Read by {name}', { name });
        case 'writes_table': return t('solutions.rel_writes_table', 'Written to by {name}', { name });
        case 'uses_table': return t('solutions.rel_uses_table', 'Table used by {name}', { name });
        case 'uses_template': return t('solutions.rel_uses_template', 'Template used by {name}', { name });
        case 'uses_skill': return t('solutions.rel_uses_skill', 'Skill used by {name}', { name });
        case 'uses_agent': return t('solutions.rel_uses_agent', 'Agent used by {name}', { name });
        case 'grounds_on_kb': return t('solutions.rel_grounds_on_kb', 'Knowledge for {name}', { name });
        case 'writes_kb': return t('solutions.rel_writes_kb', 'Written to by {name}', { name });
        case 'skill_runs': return t('solutions.rel_skill_runs', 'Run by the skill {name}', { name });
        default: return t('solutions.rel_needed_by', 'Needed by {name}', { name });
    }
}

/** "Why is this here": the first part that needs it, and how many more do. */
export function whyText(t: Translate, part: RelatedPart): string {
    const first = part.via[0];
    const name = first?.name || t('solutions.related_unknown_part', 'a part');
    const text = reasonOf(t, first?.relation ?? part.relation, name);
    return part.via.length > 1
        ? t('solutions.related_and_more', '{reason} (+{count} more)', { reason: text, count: part.via.length - 1 })
        : text;
}

export function whyNot(t: Translate, part: RelatedPart): string {
    if (part.status === 'in_other_solution') {
        return part.solutionName
            ? t('solutions.add_in_other', 'In {name}', { name: part.solutionName })
            : t('solutions.add_in_other_unnamed', 'In another Solution');
    }
    if (part.status === 'not_yours') return t('solutions.related_not_yours', 'Not yours to add');
    return t('solutions.related_missing', 'No longer exists');
}

export function partLabel(t: Translate, part: Pick<RelatedPart, 'name'>): string {
    return part.name || t('solutions.related_unknown_part', 'a part');
}
