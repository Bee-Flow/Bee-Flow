// @vitest-environment node
import { expect, it } from 'vitest';
import { extractFormState, buildPatch } from './formState';

it('retains reviewed document revision, overrides, typed false/zero and repeating values when canvas settings save', () => {
    const step = { id:'fill', type:'fill_document', documentId:'template', documentVersionId:'reviewed-v1',
        sectionOverrides:{cloud:'exclude'}, values:{enabled:false,count:0,rows:[{name:'Item',amount:0}],customer:'{{input.name}}',empty:''} };
    const draft = extractFormState(step);
    draft.documentVersionId = 'reviewed-v2';
    draft.sectionOverrides = {cloud:'include'};
    draft.values = {...draft.values, count:0, enabled:false};
    const patch = {...step, ...buildPatch(step, draft)};
    expect(patch.documentVersionId).toBe('reviewed-v2');
    expect(patch.sectionOverrides).toEqual({cloud:'include'});
    expect(patch.values).toEqual({enabled:false,count:0,rows:[{name:'Item',amount:0}],customer:'{{input.name}}'});
});
