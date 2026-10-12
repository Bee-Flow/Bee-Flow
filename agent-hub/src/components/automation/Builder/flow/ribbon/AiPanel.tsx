import { Bot, Zap } from 'lucide-react';
import useTranslation from '../../../../../hooks/useTranslation';
import { nativeAppPills } from './AppCommands';
import type { OpenState } from './AppCommands';
import { planPills } from './CommandsPanel';
import { DropdownPill } from './MenuPanel';
import PillRow from './PillRow';
import type { RowPill } from './PillRow';
import { resultRow } from './menuRows';
import { planRow } from './ribbonRows';
import { agentResult, skillResult } from './ribbonSearch';
import type { AgentRow, SkillRow } from './ribbonSearch';
import type { PaletteItem, RibbonApp, StepPayload } from './ribbonCategories';

type AddFn = (payload: StepPayload) => void;

interface AiPanelProps extends OpenState {
    items: PaletteItem[];
    /** null: the list could not be read, which is not the same as none. */
    agents: AgentRow[] | null;
    skills: SkillRow[];
    /** Bee Flow's own AI tools (web search, memory, transcription, ...), after the agents and skills. */
    apps?: RibbonApp[];
    enabled: boolean;
    onAdd: AddFn;
}

const AI_ORIGIN = 'section:ai';

/**
 * The AI tab as one row: AI step and Extract data add on click, "Use an
 * agent" and "Apply a skill" list the org's agents and skills. Every row in
 * those lists drags straight onto the canvas: an agent lands as an AI step
 * with `agentId`, a skill as one with `skillIds: [id]`. An agent that cannot
 * be used stays in the list with its reason. Bee Flow's own AI tools (web
 * search, memory, transcription, image and video) close the row.
 */
export default function AiPanel({ items, agents, skills, apps = [], enabled, onAdd, openKey, setOpenKey }: AiPanelProps) {
    const { t } = useTranslation();
    const open = { openKey, setOpenKey };
    const title = t('automations.ribbon.cat_ai', 'AI');
    const dragHint = t('automations.ribbon.ai_drag_caption', 'Drag an agent or skill straight onto the canvas');
    const agentRows = (agents || []).map(a => resultRow(agentResult(a, t('automations.ribbon.agent', 'Agent'))));
    const skillRows = skills.map(s => resultRow(skillResult(s, t('automations.ribbon.skill', 'Skill'))));
    const agentsTitle = t('automations.ribbon.agents', 'Agents');
    const skillsTitle = t('automations.ribbon.skills', 'Skills');

    const lists: RowPill[] = [
        {
            key: 'agents',
            node: (
                <DropdownPill
                    id="__agents"
                    label={t('automations.ribbon.use_agent', 'Use an agent')}
                    glyph={<Bot size={14} className="text-[var(--type-ai)]" />}
                    desc={t('automations.ribbon.use_agent_desc', 'An agent from Studio, with its role, knowledge and skills. One place to maintain.')}
                    tipFooter={dragHint}
                    origin={AI_ORIGIN}
                    title={agentsTitle}
                    hint={agentRows.length > 0 ? dragHint : null}
                    sections={[{ key: 'agents', title: agentsTitle, rows: agentRows }]}
                    filterLabel={(n) => t('automations.ribbon.filter_agents', 'Filter {n} agents…', { n })}
                    emptyText={agents === null
                        ? t('automations.ribbon.agents_unreadable', 'The list of agents could not be read. Try again in a moment.')
                        : t('automations.ribbon.agents_empty', 'No agents yet. Build one under Agents first.')}
                    onAdd={onAdd}
                    {...open}
                />
            ),
            fold: { key: 'agents', title: agentsTitle, rows: agentRows },
            origins: [AI_ORIGIN],
        },
        {
            key: 'skills',
            node: (
                <DropdownPill
                    id="__skills"
                    label={t('automations.ribbon.apply_skill', 'Apply a skill')}
                    glyph={<Zap size={14} className="text-[var(--kind-skill)]" />}
                    desc={t('automations.ribbon.apply_skill_desc', 'A skill from Studio, applied without an agent.')}
                    tipFooter={dragHint}
                    origin={AI_ORIGIN}
                    title={skillsTitle}
                    hint={skillRows.length > 0 ? dragHint : null}
                    sections={[{ key: 'skills', title: skillsTitle, rows: skillRows }]}
                    filterLabel={(n) => t('automations.ribbon.filter_skills', 'Filter {n} skills…', { n })}
                    emptyText={t('automations.ribbon.skills_empty', 'No skills yet.')}
                    onAdd={onAdd}
                    {...open}
                />
            ),
            fold: { key: 'skills', title: skillsTitle, rows: skillRows },
            origins: [AI_ORIGIN],
        },
    ];

    const tools = nativeAppPills(apps, title, { onAdd, t, ...open });

    return (
        <PillRow
            segments={[...planPills(planRow(items, 'ai', AI_ORIGIN, t), title, onAdd, open), lists, ...(tools.length > 0 ? [tools] : [])]}
            testId="ribbon-ai"
            enabled={enabled}
            onAdd={onAdd}
            {...open}
        />
    );
}
