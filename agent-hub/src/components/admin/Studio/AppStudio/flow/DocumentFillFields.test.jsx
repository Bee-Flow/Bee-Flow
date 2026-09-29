import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const api=vi.hoisted(()=>({documentRequest:vi.fn(),listTemplates:vi.fn()}));
vi.mock('../../../../../pages/documents/documentsApi',()=>api);
vi.mock('../../../../../hooks/useTranslation',()=>({default:()=>({locale:'en'})}));
vi.mock('../inspector/panels/BindingField',()=>({default:()=> <div data-testid="binding"/>}));
import DocumentFillFields from './DocumentFillFields';
// Every wait in this file is a POSITIVE one: the contract, the template list
// and the onChange all do arrive, and the only question is when. One second
// is plenty on an idle box and not enough when 1,186 test files share the
// machine with another suite, and the failure then reads as a product bug
// that is not there. A longer budget resolves just as fast when the box is
// quiet — a positive wait returns the moment its condition holds — so this
// makes the file slower under load, never blinder.
const ARRIVES = { timeout: 15_000 };
const contract={documentId:'d',versionId:'reviewed',name:'Security',instructions:'Verified facts only',parameters:Array.from({length:55},(_,i)=>({key:`p${i}`,label:`Parameter ${i}`,type:'text',instructions:`Detailed instructions ${i}`,required:true})),sections:[{id:'cloud',title:'Cloud'}]};
beforeEach(()=>{api.documentRequest.mockReset().mockResolvedValue({contract});api.listTemplates.mockReset().mockResolvedValue([{id:'d',name:'Security'}]);});
it('loads the pinned full contract outside catalog caps and keeps parameter guidance accessible',async()=>{
    render(<DocumentFillFields step={{documentId:'d',documentVersionId:'reviewed',values:{}}} onChange={vi.fn()}/>);
    await screen.findByText('Verified facts only', {}, ARRIVES);
    expect(api.documentRequest).toHaveBeenCalledWith('/d/contract?versionId=reviewed');
    expect(screen.getAllByTestId('binding')).toHaveLength(55);
    expect(screen.getByText('Detailed instructions 54')).toBeInTheDocument();
});
it('reads and pins a selected template before changing the action',async()=>{
    const onChange=vi.fn();render(<DocumentFillFields step={{}} onChange={onChange}/>);
    await screen.findByRole('option',{name:'Security'}, ARRIVES);
    fireEvent.change(screen.getByLabelText('Document template'),{target:{value:'d'}});
    await waitFor(()=>expect(onChange).toHaveBeenCalledWith({documentId:'d',documentVersionId:'reviewed',values:{},sectionOverrides:{}}), ARRIVES);
    expect(api.documentRequest).toHaveBeenCalledWith('/d/contract');
});
