import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const state=vi.hoisted(()=>({locale:'en',request:vi.fn()}));
vi.mock('./documentsApi',()=>({documentRequest:state.request}));
// The panel's strings are catalogue keys (documents.workspace.*) now, not
// inline English/Dutch pairs picked by locale: the Dutch comes from the i18n
// catalogue. This stand-in plays that catalogue for the keys the Dutch test reads.
const NL={'documents.workspace.font':'Lettertype','documents.workspace.preview_design_changes':'Vormgeving vooraf bekijken','documents.workspace.review_proposal':'Voorstel controleren'};
vi.mock('../../hooks/useTranslation',()=>({default:()=>({locale:state.locale,t:(key,fallback)=>(state.locale==='nl'&&NL[key])||fallback})}));
import DocumentWorkspacePanel from './DocumentWorkspacePanel';
const doc={id:'d',kind:'document',versionId:'v1',settings:{},contract:{instructions:'Verified facts only',parameters:[
    {key:'cloud',label:'Cloud services',type:'boolean',summary:'Uses cloud',instructions:'Confirm with the customer'},
    {key:'count',label:'Device count',type:'number',required:true},
],sections:[{id:'cloud-section',title:'Cloud controls',condition:{all:[{parameter:'cloud',operator:'equals',value:true}]}}]}};
const props=()=>({doc,onSave:vi.fn(async patch=>({...doc,...patch,versionId:'v2'})),onBeforeAction:vi.fn(),onRefresh:vi.fn(),onInsert:vi.fn(),onSection:vi.fn()});
beforeEach(()=>{sessionStorage.clear();state.locale='en';state.request.mockReset().mockResolvedValue({documents:[],updates:[]});});

it('sends typed false and zero to the same validation endpoint and shows exclusion reasons',async()=>{
    const p=props();state.request.mockResolvedValue({valid:true,sections:[{id:'cloud-section',title:'Cloud controls',state:'excluded',reason:'cloud equals false'}],html:'<p>Customer</p>'});
    render(<DocumentWorkspacePanel {...p} tab="preview"/>);
    fireEvent.change(screen.getByLabelText('Cloud services'),{target:{value:'false'}});
    fireEvent.change(screen.getByLabelText('Device count *'),{target:{value:'0'}});
    fireEvent.click(screen.getByText('Validate & preview'));
    await screen.findByText('Ready to generate');
    expect(state.request).toHaveBeenCalledWith('/d/validate',{values:{cloud:false,count:0},sectionOverrides:undefined});
    expect(screen.getByText('Cloud controls: Excluded')).toBeInTheDocument();
    expect(screen.getByText('cloud equals false')).toBeInTheDocument();
});
it('keeps a proposed design unapplied until review, then pins its expected revision',async()=>{
    const p=props();state.request.mockResolvedValue({explanation:'Formal typography',expectedVersionId:'v1',patch:{settings:{contract:doc.contract,design:{font:'serif'}}},html:'<p>Preview</p>'});
    render(<DocumentWorkspacePanel {...p} tab="design"/>);
    fireEvent.change(screen.getByLabelText('Font'),{target:{value:'serif'}});
    fireEvent.click(screen.getByText('Preview design changes'));
    await screen.findByRole('dialog',{name:'Review proposal'});
    expect(p.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Apply reviewed changes'));
    await waitFor(()=>expect(p.onSave).toHaveBeenCalledWith(expect.objectContaining({expectedVersionId:'v1',settings:{contract:doc.contract,design:{font:'serif'}}})));
});
it('offers Dutch controls and keyboard dismissal for the proposal dialog',async()=>{
    state.locale='nl';state.request.mockResolvedValue({explanation:'Voorbeeld',patch:{},html:'<p>Voorbeeld</p>'});
    render(<DocumentWorkspacePanel {...props()} tab="design"/>);
    expect(screen.getByLabelText('Lettertype')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Vormgeving vooraf bekijken'));
    await screen.findByRole('dialog',{name:'Voorstel controleren'});
    // findByRole resolves on the DOM; the Modal registers its Escape listener
    // in an effect that flushes a beat later. Flush it before pressing the key,
    // or on a slow runner the keystroke lands before anyone is listening.
    await act(async()=>{});
    fireEvent.keyDown(document,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('retains failed parameter edits across unmount and rejects saving over a newer revision',async()=>{
    const p=props();p.onSave.mockRejectedValue(new Error('Offline'));
    const first=render(<DocumentWorkspacePanel {...p} tab="parameters"/>);
    fireEvent.change(screen.getByLabelText('Document instructions'),{target:{value:'Recovered instructions'}});
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByText('Offline');first.unmount();
    const retry=props();
    render(<DocumentWorkspacePanel {...retry} doc={{...doc,versionId:'v3'}} tab="parameters"/>);
    expect(screen.getByLabelText('Document instructions')).toHaveValue('Recovered instructions');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(()=>expect(retry.onSave).toHaveBeenCalledWith(expect.objectContaining({expectedVersionId:'v1'})));
});
