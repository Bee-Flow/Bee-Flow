/**
 * MermaidView — mermaid diagram atom node-view.
 * Reuses the existing, TipTap-free MermaidBlock component verbatim.
 */
import React from 'react';
import MermaidBlock from '../../pages/documents/notebook/MermaidBlock';
import type { DocNode } from '../model/schema.js';
import type { EditorView } from '../engine/view';

export default function MermaidView({ node, view, editable }: { node: DocNode; view: EditorView; editable?: boolean }) {
  return (
    <div className="notebook-mermaid-block" onMouseDown={() => view.selectAtom(node)}>
      <MermaidBlock
        code={node.attrs?.code || ''}
        // 'type' so editing the diagram source coalesces in the undo stack —
        // it used to cost one history entry and one whole-document
        // re-serialization per keystroke.
        onCodeChange={(code: string) => view.updateAtom(node, { code }, { kind: 'type' })}
        editable={!!editable}
      />
    </div>
  );
}
