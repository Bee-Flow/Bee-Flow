import { useMemo } from 'react';
import SideDrawer from '@/components/shared/SideDrawer';
import { useViewport } from '@/hooks/useViewport';
import { DrawerBreakdown, DrawerStats, RelatedCalls } from './drawer/DrawerSections';
import type { DrawerDetail, ModelRate, UsageRow } from './drawer/drawerTypes';

interface DetailDrawerProps {
    detail: DrawerDetail;
    modelCosts: Record<string, ModelRate | undefined>;
    costPerModel: Record<string, number>;
    recent: UsageRow[];
    onClose: () => void;
}

/**
 * One model's or agent's totals, token breakdown and recent calls, in the
 * shared SideDrawer: a card over the right of the page (its host is the
 * positioned content pane), a right-side dialog on a phone.
 */
export function DetailDrawer({ detail, modelCosts, costPerModel, recent, onClose }: DetailDrawerProps) {
    const { type, data } = detail;
    const { isMobile } = useViewport();
    const eyebrow = type === 'model' ? 'Model Details' : 'Agent Details';

    // Get recent calls related to this item
    const relatedCalls = useMemo(() => {
        if (type === 'model') return recent.filter((r) => r.model === data.model).slice(0, 20);
        if (type === 'agent') return recent.filter((r) => r.agent_name === data.agent_name).slice(0, 20);
        return [];
    }, [type, data, recent]);

    return (
        <SideDrawer
            open
            onClose={onClose}
            mode={isMobile ? 'modal' : 'overlay'}
            width={440}
            ariaLabel={eyebrow}
            testId="monitoring-detail"
            header={(
                <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">{eyebrow}</div>
                    <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                        {type === 'model' ? data.model : data.agent_name || 'Unknown'}
                    </div>
                </div>
            )}
        >
            <DrawerStats type={type} data={data} costPerModel={costPerModel} />
            <DrawerBreakdown type={type} data={data} modelCosts={modelCosts} />
            <RelatedCalls type={type} calls={relatedCalls} modelCosts={modelCosts} />
        </SideDrawer>
    );
}
