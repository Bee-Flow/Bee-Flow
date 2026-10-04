import React from 'react';
import { Table2, Search, Plus, RefreshCw, Trash2 } from 'lucide-react';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import { datatableSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

// One icon per operation, so "this one deletes" is legible at canvas zoom
// without reading the summary line.
const OP_ICON = {
    find_rows: Search,
    add_row: Plus,
    save_row: RefreshCw,
    update_rows: RefreshCw,
    delete_rows: Trash2,
};

export default function DatatableNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, tableNameById, datatablesById } = data;
    const Icon = OP_ICON[step.op] || Table2;
    const table = datatablesById?.[step.datatableId];
    const writes = step.op && step.op !== 'find_rows';
    const shared = table?.scope && table.scope !== 'personal';

    // A write outlives the run and other automations read it; shared means
    // somebody else can read what this writes. Both worth saying on the card.
    const badges = (writes || shared) ? (
        <>
            {writes && <NodeChip tone="warn" title="This step changes stored data — the change outlives the run.">writes</NodeChip>}
            {shared && <NodeChip title="Other people can read this table.">{table.scope === 'org' ? 'org' : 'shared'}</NodeChip>}
        </>
    ) : null;

    return (
        <StepNodeBase
            icon={<Icon size={14} />}
            typeLabel={nodeTypeLabel('datatable')}
            help={nodeHelp('datatable')}
            name={step.label || nodeDefaultLabel('datatable')}
            sub={datatableSummary(step, { tableNameById })}
            subTitle={table?.name || step.datatableId}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
