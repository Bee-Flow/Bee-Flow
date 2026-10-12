/**
 * What every card on the outline reads besides its own step: the step names
 * (for "from ‹Search email ▸ Results›" in a summary — every step's, a loop's
 * body included, and the card's own name for one without a label), the table
 * the step types (which steps are Conditions), the table
 * and knowledge-base names the catalog knows, the last test run, the findings
 * and the step numbers. Built once per change, not per card.
 */

import { useMemo } from 'react';

import { useTranslation } from '@/core/i18n';
import type { FlowCatalog } from '@/features/flow-editor/api';
import { buildStepTypeMap, stepNumbers, type FlowDefinition, type StepIssues } from '@/features/flow-editor/model';

import type { CardContext, RunRow } from '../outline/cardModel';
import { cardLabelMap } from '../outline/stepLabels';

function namesById(rows: readonly { id: string | number; name?: unknown }[] | undefined): Record<string, string> {
    return Object.fromEntries((rows ?? []).map((r) => [String(r.id), typeof r.name === 'string' ? r.name : '']));
}

export function useCardContext(
    definition: FlowDefinition | null,
    catalog: FlowCatalog | null,
    runByStep: ReadonlyMap<string, RunRow>,
    issuesByStep: ReadonlyMap<string, StepIssues>,
): CardContext {
    const t = useTranslation();
    return useMemo(
        () => ({
            t,
            stepLabelById: cardLabelMap(definition, t),
            stepTypeById: buildStepTypeMap(definition),
            // Null (not {}) until the catalog answers: a card then says "a table", not "a table you can no longer see".
            tableNameById: catalog ? namesById(catalog.datatables) : null,
            kbNameById: catalog ? namesById(catalog.knowledgeBases) : null,
            runByStep,
            issuesByStep,
            numbers: stepNumbers(definition),
        }),
        [t, definition, catalog, runByStep, issuesByStep],
    );
}
