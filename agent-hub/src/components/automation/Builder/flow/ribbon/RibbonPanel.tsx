import useTranslation from '../../../../../hooks/useTranslation';
import SuggestedPanel from './SuggestedPanel';
import AiPanel from './AiPanel';
import CommandsPanel from './CommandsPanel';
import { SuitePanel, OtherAppsPanel } from './AppsPanels';
import type { OpenState } from './AppCommands';
import { CATEGORY_DEFS, SUITE_TABS, isSuiteTab } from './ribbonCategories';
import type { RibbonApp, RibbonCategoryId, RibbonSections, StepPayload } from './ribbonCategories';
import { planBlocksRow, planRow } from './ribbonRows';
import type { RowTab } from './ribbonRows';
import type { FitCard, FrequentItem } from './fitsAfter';
import type { AgentRow, SkillRow } from './ribbonSearch';
import type { RibbonAnchor } from './ribbonAnchor';

interface Props extends OpenState {
    category: RibbonCategoryId;
    sections: RibbonSections;
    anchor: RibbonAnchor | null;
    cards: FitCard[];
    frequent: FrequentItem[];
    agents: AgentRow[] | null;
    skills: SkillRow[];
    /** The panel is on screen (a row only measures itself then). */
    open: boolean;
    onAdd: (payload: StepPayload) => void;
}

const STEP_TABS: Record<string, { items: (s: RibbonSections) => RibbonSections['logic']; apps: (s: RibbonSections) => RibbonApp[]; testId: string }> = {
    logic: { items: s => s.logic, apps: s => s.nativeApps.logic, testId: 'ribbon-logic' },
    people: { items: s => s.people, apps: () => [], testId: 'ribbon-people' },
    data: { items: s => s.data, apps: s => s.nativeApps.data, testId: 'ribbon-data' },
};

/**
 * The one category the expanded ribbon shows, always as one row of pills
 * (flow/ribbon/PillRow.tsx). Each panel is keyed by its tab, so a row's fold
 * state never carries over to the next tab.
 */
export default function RibbonPanel({ category, sections, anchor, cards, frequent, agents, skills, open, onAdd, openKey, setOpenKey }: Props) {
    const { t } = useTranslation();
    const openProps = { openKey, setOpenKey };
    const def = CATEGORY_DEFS.find(c => c.id === category);
    const title = def ? t(def.labelKey, def.fallback) : '';
    const step = STEP_TABS[category];
    if (step) {
        return (
            <CommandsPanel
                key={category}
                segments={planRow(step.items(sections), category as RowTab, def?.origin || null, t)}
                title={title}
                apps={step.apps(sections)}
                testId={step.testId}
                enabled={open}
                onAdd={onAdd}
                {...openProps}
            />
        );
    }
    if (isSuiteTab(category)) {
        return (
            <SuitePanel
                key={category}
                category={SUITE_TABS[category]}
                apps={sections.suiteApps[category]}
                testId={`ribbon-${category}`}
                enabled={open}
                onAdd={onAdd}
                {...openProps}
            />
        );
    }
    switch (category) {
        case 'suggested':
            return <SuggestedPanel anchor={anchor} cards={cards} frequent={frequent} onAdd={onAdd} />;
        case 'ai':
            return <AiPanel key="ai" items={sections.ai} agents={agents} skills={skills} apps={sections.nativeApps.ai} enabled={open} onAdd={onAdd} {...openProps} />;
        case 'other_apps':
            return <OtherAppsPanel key="other_apps" categories={sections.otherAppCategories} enabled={open} onAdd={onAdd} {...openProps} />;
        default:
            return (
                <CommandsPanel
                    key="blocks"
                    segments={planBlocksRow(sections.flowlets, sections.blockSections, t)}
                    title={title}
                    testId="ribbon-blocks"
                    enabled={open}
                    empty={t('automations.ribbon.blocks_empty', 'No building blocks yet. Group steps into a flowlet to reuse them.')}
                    onAdd={onAdd}
                    {...openProps}
                />
            );
    }
}
