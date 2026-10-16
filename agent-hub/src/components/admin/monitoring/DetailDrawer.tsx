import { useMemo } from 'react';
import { DrawerBreakdown, DrawerStats, RelatedCalls } from './drawer/DrawerSections';
import { S } from './drawer/drawerTypes';
import type { DrawerDetail, ModelRate, UsageRow } from './drawer/drawerTypes';
import { COLORS } from './shared';

interface DetailDrawerProps {
    detail: DrawerDetail;
    modelCosts: Record<string, ModelRate | undefined>;
    costPerModel: Record<string, number>;
    recent: UsageRow[];
    onClose: () => void;
}

/** Side drawer with one model's or agent's totals, token breakdown and recent calls. */
export function DetailDrawer({ detail, modelCosts, costPerModel, recent, onClose }: DetailDrawerProps) {
    const { type, data } = detail;

    // Get recent calls related to this item
    const relatedCalls = useMemo(() => {
        if (type === 'model') {
            return recent.filter((r) => r.model === data.model).slice(0, 20);
        }
        if (type === 'agent') {
            return recent
                .filter((r) => r.agent_name === data.agent_name)
                .slice(0, 20);
        }
        return [];
    }, [type, data, recent]);

    return (
        <>
            <div style={S.overlay} onClick={onClose} />
            <div style={S.drawer}>
                {/* Header */}
                <div style={S.header}>
                    <div>
                        <div
                            style={{
                                fontSize: '10px',
                                fontWeight: 600,
                                color: COLORS.primary,
                                textTransform: 'uppercase',
                                letterSpacing: '0.1em',
                                marginBottom: '4px',
                            }}
                        >
                            {type === 'model' ? 'Model Details' : 'Agent Details'}
                        </div>
                        <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary, #fff)' }}>
                            {type === 'model' ? data.model : data.agent_name || 'Unknown'}
                        </div>
                    </div>
                    <button onClick={onClose} style={S.closeButton}>
                        ×
                    </button>
                </div>

                <DrawerStats type={type} data={data} costPerModel={costPerModel} />
                <DrawerBreakdown type={type} data={data} modelCosts={modelCosts} />
                <RelatedCalls type={type} calls={relatedCalls} modelCosts={modelCosts} />
            </div>

            <style>{`
                @keyframes slideInRight {
                    from { transform: translateX(100%); }
                    to { transform: translateX(0); }
                }
            `}</style>
        </>
    );
}
