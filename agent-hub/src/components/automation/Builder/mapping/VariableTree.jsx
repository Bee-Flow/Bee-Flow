import { ChevronDown, ChevronRight, Database, Zap, Sparkles, GitBranch, Repeat, Code, Bell, Workflow, GripVertical, Globe, ClipboardList, FileText, FileSignature, ShieldCheck, Table2, BookOpen, ScanText, RectangleHorizontal, Presentation } from 'lucide-react';
import React, { useState } from 'react';
import { startPathDrag } from './bindingDnd';
import { humanizeFieldKey } from '../flow/displayHelpers';
import SourceNode from '../sources/SourceNode';

/**
 * Start an HTML5 drag carrying a binding path — dropped onto a BindingField /
 * TemplateField it inserts the reference (whole-node output or a leaf field).
 *
 * BOTH MIME types matter: `application/x-binding-path` is what bindingDnd.js
 * reads, `text/plain` is what a plain <input> gets when the drop lands on a
 * control that has no binding handler.
 *
 * Moved to bindingDnd.js (the drag/drop plumbing module) now that the
 * VariablePicker popover is a drag source too; re-exported here so the existing
 * importers keep resolving.
 */
export { startPathDrag };

/**
 * Right-side variable browser inside the StepInspector. Lists all
 * upstream nodes (trigger + reachable steps) with their output fields
 * and sample values, n8n-style. Clicking a leaf calls onInsert(path)
 * with the bare dotted path; the parent decides whether to wrap it as
 * `{{...}}` (template) or insert raw (expression).
 *
 * Props:
 *   groups    — output of useUpstreamVariables(definition, currentStepId, catalog)
 *   onInsert  — (path: string) => void
 *   activeFieldLabel — optional string shown at the top so the user knows
 *                     which field the insert will target
 */
export default function VariableTree({ groups = [], onInsert, activeFieldLabel = null, previewSample = null }) {
    if (!groups || groups.length === 0) {
        return (
            <div className="h-full flex flex-col">
                <TreeHeader activeFieldLabel={activeFieldLabel} />
                <div className="flex-1 px-4 py-6 text-xs text-[var(--text-tertiary)] italic">
                    No upstream data yet. Connect this step to a previous one to see its output here.
                </div>
            </div>
        );
    }
    return (
        <div className="h-full flex flex-col">
            <TreeHeader activeFieldLabel={activeFieldLabel} />
            <div className="flex-1 overflow-auto custom-scrollbar py-1">
                {groups.map(group => (
                    <GroupNode key={group.id} group={group} onInsert={onInsert} previewSample={previewSample} />
                ))}
            </div>
            <div className="px-3 py-2 border-t border-[var(--border-default)] text-[10px] text-[var(--text-tertiary)]">
                Click a value to insert it, or drag it into a field. Drag a step's row to use its whole output.
            </div>
        </div>
    );
}

function TreeHeader({ activeFieldLabel }) {
    return (
        <div className="px-3 py-2 border-b border-[var(--border-default)]">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]">
                Variables
            </div>
            {activeFieldLabel && (
                <div className="mt-0.5 text-[11px] text-[var(--text-secondary)] truncate">
                    insert into <span className="font-mono">{activeFieldLabel}</span>
                </div>
            )}
        </div>
    );
}

const KIND_ICON = {
    trigger:            () => <Zap size={12} />,
    integration_action: () => <Database size={12} />,
    ai_step:            () => <Sparkles size={12} />,
    data_extraction:    () => <ScanText size={12} />,
    condition:          () => <GitBranch size={12} />,
    loop:               () => <Repeat size={12} />,
    code:               () => <Code size={12} />,
    notification:       () => <Bell size={12} />,
    http_request:       () => <Globe size={12} />,
    form_page:          () => <ClipboardList size={12} />,
    approval:           () => <ShieldCheck size={12} />,
    generate_document:  () => <FileText size={12} />,
    fill_document:      () => <FileSignature size={12} />,
    slide:              () => <RectangleHorizontal size={12} />,
    presentation:       () => <Presentation size={12} />,
    datatable:          () => <Table2 size={12} />,
    knowledge_write:    () => <BookOpen size={12} />,
};

/**
 * The group label already names the step; the caption is just a hint of the
 * base path. Strip the `steps.<id>.` prefix so the cryptic id never shows
 * (e.g. `steps.ai_87e358.output` → "Output"); trigger/loop bases are kept
 * (`loop.klant` → "Loop klant").
 *
 * The remainder is then read as WORDS rather than as a path fragment: a
 * caption is a label, and `currentUser` or `trigger` in monospace is the kind
 * of thing that makes a non-technical author believe they are looking at code
 * they must not touch. Full id-bearing path stays available via the element
 * `title` — that is the string an expression actually needs, so it is demoted,
 * never deleted (same rule ConditionNode/FilterNode follow on the canvas).
 *
 * Exported because VariablePicker's group header shows the same caption: the
 * two lists a user picks a variable from must not disagree about what a step's
 * output is called.
 *
 * Pass the group's `label` to get '' when the caption would only repeat it —
 * the trigger group is literally named "Trigger" and based at `trigger`, App
 * Studio's is "Current user" at `currentUser`, and humanising both sides turns
 * a hint into a stutter. Nothing is lost by dropping it: the raw path is on the
 * row's `title` either way.
 */
export function friendlyBasePath(basePath, label = '') {
    const withoutStep = String(basePath || '').replace(/^steps\.[^.]+\./, '');
    const words = humanizeFieldKey(withoutStep) || withoutStep;
    if (words.toLowerCase() === String(label || '').trim().toLowerCase()) return '';
    return words;
}

function GroupNode({ group, onInsert, previewSample }) {
    const [open, setOpen] = useState(true);
    const Icon = KIND_ICON[group.kind] ? KIND_ICON[group.kind](group) : <Workflow size={12} />;
    const caption = friendlyBasePath(group.basePath, group.label);
    // Drag the whole node row to reference its ENTIRE output (e.g.
    // steps.<id>.output); click toggles the field list.
    return (
        <div className="border-b border-[var(--border-default)] last:border-b-0 group/grp">
            <div
                draggable
                onDragStart={(e) => startPathDrag(e, group.basePath)}
                onClick={() => setOpen(o => !o)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
                title={`Drag to use the whole output (${group.basePath})`}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-[var(--bg-secondary)] cursor-grab active:cursor-grabbing select-none"
            >
                <GripVertical size={11} className="shrink-0 text-[var(--text-tertiary)] opacity-0 group-hover/grp:opacity-60" />
                {open ? <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" />}
                <span className="text-[var(--text-secondary)]">{Icon}</span>
                <span className="text-[var(--text-primary)] font-medium truncate">{group.label}</span>
                {caption && (
                    <span className="ml-auto text-[10px] text-[var(--text-tertiary)] truncate max-w-[120px]" title={group.basePath}>
                        {caption}
                    </span>
                )}
            </div>
            {open && (
                <div className="pb-1">
                    {(group.fields || []).map(f => (
                        <SourceNode key={f.path} node={f} onInsert={onInsert} depth={1} previewSample={previewSample} />
                    ))}
                    {(group.fields || []).length === 0 && (
                        <div className="px-6 py-1 text-[11px] text-[var(--text-tertiary)] italic">No fields</div>
                    )}
                </div>
            )}
        </div>
    );
}
