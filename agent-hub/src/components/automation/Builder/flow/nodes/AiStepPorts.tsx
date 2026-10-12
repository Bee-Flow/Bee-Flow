// The ports under an AI step's card (handoff 5, round 3): what the agent or
// skill brings, each one a link into Studio. Clicking one never opens the
// step itself: the click stops here, and the link opens Studio in a new tab
// unless the host hands the canvas an in-app `onNavigate`.
import { BookOpen, Bot, Zap } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { studioHref, studioTarget } from '../studioLinks';
import type { StudioLinkSection } from '../studioLinks';

const TONE: Record<StudioLinkSection, string> = {
    agents: 'text-[var(--type-ai)] border-[var(--type-ai)]',
    skills: 'text-[var(--kind-skill)] border-[var(--kind-skill)]',
    knowledge: 'text-[var(--kind-kb)] border-[var(--kind-kb)]',
};

function PortLink({ section, id, title, children }: { section: StudioLinkSection; id: string; title: string; children: ReactNode }) {
    const rt = useNodeRuntime() as { onNavigate?: ((target: string) => void) | null };
    const onClick = (e: MouseEvent) => {
        e.stopPropagation();
        if (typeof rt.onNavigate === 'function') {
            e.preventDefault();
            rt.onNavigate(studioTarget(section, id));
        }
    };
    return (
        <a
            href={studioHref(section, id)}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            onClick={onClick}
            onMouseDown={(e) => e.stopPropagation()}
            className={`nodrag nopan inline-flex max-w-[110px] items-center gap-1 rounded-b-[8px] border border-t-0 bg-[var(--bg-card)] px-2 text-[10px] font-semibold leading-4 whitespace-nowrap hover:bg-[var(--bg-secondary)] ${TONE[section]}`}
        >
            {children}
        </a>
    );
}

export interface AiStepPortsProps {
    agentId: string | null;
    agentName: string | null;
    skillIds: string[];
    knowledgeBaseIds: string[];
}

export default function AiStepPorts({ agentId, agentName, skillIds, knowledgeBaseIds }: AiStepPortsProps) {
    const { t } = useTranslation();
    const skills = skillIds.length;
    const kbs = knowledgeBaseIds.length;
    return (
        <>
            {agentId ? (
                <PortLink section="agents" id={agentId} title={t('automations.card.open_agent', 'Open the agent in Studio')}>
                    <Bot size={10} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{agentName || t('automations.card.port_agent', 'agent')}</span>
                </PortLink>
            ) : null}
            {skills > 0 ? (
                <PortLink section="skills" id={skillIds[0]} title={t('automations.card.open_skill', 'Open the skill in Studio')}>
                    <Zap size={10} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">
                        {skills === 1
                            ? t('automations.card.port_skills', '{count} skill', { count: skills })
                            : t('automations.card.port_skills_plural', '{count} skills', { count: skills })}
                    </span>
                </PortLink>
            ) : null}
            {kbs > 0 ? (
                <PortLink section="knowledge" id={knowledgeBaseIds[0]} title={t('automations.card.open_knowledge', 'Open the knowledge base in Studio')}>
                    <BookOpen size={10} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{t('automations.card.port_knowledge', '{count} knowledge', { count: kbs })}</span>
                </PortLink>
            ) : null}
        </>
    );
}
