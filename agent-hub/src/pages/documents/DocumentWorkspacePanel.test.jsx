import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

const state=vi.hoisted(()=>({locale:'en',request:vi.fn()}));
vi.mock('./documentsApi',()=>({documentRequest:state.request}));
// The panel's strings are catalogue keys (documents.workspace.*) now, not
// inline English/Dutch pairs picked by locale: the Dutch comes from the i18n
// catalogue. This stand-in plays that catalogue for the keys the Dutch test reads.
const NL={'documents.workspace.font':'Lettertype','documents.workspace.preview_design_changes':'Vormgeving vooraf bekijken','documents.workspace.review_proposal':'Voorstel controleren'};
const fill=(text,vars)=>Object.entries(vars||{}).reduce((out,[k,v])=>out.split(`{${k}}`).join(String(v)),text);
vi.mock('../../hooks/useTranslation',()=>({default:()=>({locale:state.locale,t:(key,fallback,vars)=>fill((state.locale==='nl'&&NL[key])||fallback,vars)})}));
import DocumentWorkspacePanel from './DocumentWorkspacePanel';
const doc={id:'d',kind:'document',versionId:'v1',settings:{},contract:{instructions:'Verified facts only',parameters:[
    {key:'cloud',label:'Cloud services',type:'boolean',summary:'Uses cloud',instructions:'Confirm with the customer'},
    {key:'count',label:'Device count',type:'number',required:true},
],sections:[{id:'cloud-section',title:'Cloud controls',condition:{all:[{parameter:'cloud',operator:'equals',value:true}]}}]}};
const props=()=>({doc,onSave:vi.fn(async patch=>({...doc,...patch,versionId:'v2'})),onBeforeAction:vi.fn(),onRefresh:vi.fn(),onInsert:vi.fn(),onSection:vi.fn()});
beforeEach(()=>{sessionStorage.clear();state.locale='en';state.request.mockReset().mockResolvedValue({documents:[],updates:[]});});

it('a template takes sample data for its preview: typed false and zero go to the validation endpoint, with the exclusion reasons',async()=>{
    const user = userEvent.setup();
    const p={...props(),doc:{...doc,kind:'template'}};state.request.mockResolvedValue({valid:true,sections:[{id:'cloud-section',title:'Cloud controls',state:'excluded',reason:'cloud equals false'}],html:'<p>Customer</p>'});
    render(<DocumentWorkspacePanel {...p} tab="preview"/>);
    await user.selectOptions(screen.getByLabelText('Cloud services'), 'false');
    await user.clear(screen.getByLabelText('Device count *'));
    await user.type(screen.getByLabelText('Device count *'), '0');
    await user.click(screen.getByText('Validate & preview'));
    await screen.findByText('Ready to generate');
    expect(state.request).toHaveBeenCalledWith('/d/validate',{values:{cloud:false,count:0},sectionOverrides:undefined});
    expect(screen.getByText('Cloud controls: Excluded')).toBeInTheDocument();
    expect(screen.getByText('cloud equals false')).toBeInTheDocument();
});
it('a document is filled in with the form every place shows, and what that form saved is what this panel works with',async()=>{
    const user = userEvent.setup();
    const p=props();state.request.mockResolvedValue({valid:true,sections:[],html:'<p>Customer</p>'});
    const filled={...doc,settings:{sampleValues:{count:3}}};
    const {rerender}=render(<DocumentWorkspacePanel {...p} doc={filled} tab="preview"/>);
    // The shared form (it reads the document itself; no query client in this test, so it stays at its first line).
    expect(screen.getByText('Loading the form…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Device count *')).not.toBeInTheDocument();
    // The form saved through its own route; the editor hands the panel the document as it is now.
    rerender(<DocumentWorkspacePanel {...p} doc={{...filled,versionId:'v2',settings:{sampleValues:{count:4,cloud:true},filledBy:{count:{userId:'u1',at:'now'}}}}} tab="preview"/>);
    await user.click(screen.getByText('Validate & preview'));
    await screen.findByText('Ready to generate');
    expect(state.request).toHaveBeenCalledWith('/d/validate',{values:{count:4,cloud:true},sectionOverrides:undefined});
    // Nothing of the panel's own changed: it has nothing to save, so it cannot put older values back.
    expect(p.onSave).not.toHaveBeenCalled();
});
it('keeps a proposed design unapplied until review, then pins its expected revision',async()=>{
    const user = userEvent.setup();
    const p=props();state.request.mockResolvedValue({explanation:'Formal typography',expectedVersionId:'v1',patch:{settings:{contract:doc.contract,design:{font:'serif'}}},html:'<p>Preview</p>'});
    render(<DocumentWorkspacePanel {...p} tab="design"/>);
    await user.selectOptions(screen.getByLabelText('Font'), 'serif');
    await user.click(screen.getByText('Preview design changes'));
    await screen.findByRole('dialog',{name:'Review proposal'});
    expect(p.onSave).not.toHaveBeenCalled();
    await user.click(screen.getByText('Apply reviewed changes'));
    await waitFor(()=>expect(p.onSave).toHaveBeenCalledWith(expect.objectContaining({expectedVersionId:'v1',settings:{contract:doc.contract,design:{font:'serif'}}})));
});
it('offers Dutch controls and keyboard dismissal for the proposal dialog',async()=>{
    const user = userEvent.setup();
    state.locale='nl';state.request.mockResolvedValue({explanation:'Voorbeeld',patch:{},html:'<p>Voorbeeld</p>'});
    render(<DocumentWorkspacePanel {...props()} tab="design"/>);
    expect(screen.getByLabelText('Lettertype')).toBeInTheDocument();
    await user.click(screen.getByText('Vormgeving vooraf bekijken'));
    await screen.findByRole('dialog',{name:'Voorstel controleren'});
    // findByRole resolves on the DOM; the Modal registers its Escape listener
    // in an effect that flushes a beat later. Flush it before pressing the key,
    // or on a slow runner the keystroke lands before anyone is listening.
    await act(async()=>{});
    fireEvent.keyDown(document,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('retains failed parameter edits across unmount and rejects saving over a newer revision',async()=>{
    const user = userEvent.setup();
    const p=props();p.onSave.mockRejectedValue(new Error('Offline'));
    const first=render(<DocumentWorkspacePanel {...p} tab="parameters"/>);
    await user.clear(screen.getByLabelText('Document instructions'));
    await user.type(screen.getByLabelText('Document instructions'), 'Recovered instructions');
    await user.click(screen.getByText('Save changes'));
    await screen.findByText('Offline');first.unmount();
    const retry=props();
    render(<DocumentWorkspacePanel {...retry} doc={{...doc,versionId:'v3'}} tab="parameters"/>);
    expect(screen.getByLabelText('Document instructions')).toHaveValue('Recovered instructions');
    await user.click(screen.getByText('Save changes'));
    await waitFor(()=>expect(retry.onSave).toHaveBeenCalledWith(expect.objectContaining({expectedVersionId:'v1'})));
});
it('saves a recovered copy as the same kind of document, named in the reader\'s language',async()=>{
    const user = userEvent.setup();
    sessionStorage.setItem('document-settings-draft:d',JSON.stringify({settings:{contract:doc.contract},kind:'document',visibility:'private',versionId:'v0',bodyHtml:'# Deck'}));
    state.request.mockResolvedValue({document:{name:'Deck (recovered)'}});
    render(<DocumentWorkspacePanel {...props()} doc={{...doc,name:'Deck',docType:'presentation'}} tab="parameters"/>);
    await user.click(screen.getByText('Save recovered copy'));
    await waitFor(()=>expect(state.request).toHaveBeenCalledWith('',expect.objectContaining({name:'Deck (recovered)',docType:'presentation',bodyHtml:'# Deck'})));
});
it('never saves a field without a usable, unique key, and says so next to it',async()=>{
    const user = userEvent.setup();
    const p=props();
    render(<DocumentWorkspacePanel {...p} tab="parameters"/>);
    await user.click(screen.getByText('Add parameter'));
    await user.click(screen.getByText('Save changes'));
    expect(await screen.findByText(/Give it a key/)).toBeInTheDocument();
    expect(p.onSave).not.toHaveBeenCalled();
    const keys=screen.getAllByLabelText('Parameter key');
    await user.type(keys[2],'cloud');
    expect(screen.getAllByText(/already uses this key/).length).toBeGreaterThan(0);
    await user.clear(keys[2]);await user.type(keys[2],'bad key');
    expect(screen.getByText(/Use only letters, digits/)).toBeInTheDocument();
    await user.clear(keys[2]);await user.type(keys[2],'site.name');
    await user.click(screen.getByText('Save changes'));
    await waitFor(()=>expect(p.onSave).toHaveBeenCalled());
});
it('offers a condition only once there is something to check',async()=>{
    render(<DocumentWorkspacePanel {...props()} doc={{...doc,contract:{parameters:[],sections:[{id:'s1',title:'Intro',condition:null}]}}} tab="sections"/>);
    expect(screen.getByRole('button',{name:'Add condition'})).toBeDisabled();
    expect(screen.getByText(/Add one on the Parameters tab first/)).toBeInTheDocument();
});
it('shows the library place only to the owner, and lets a reader save a copy as template',async()=>{
    const user = userEvent.setup();
    const first=render(<DocumentWorkspacePanel {...props()} doc={{...doc,deletable:false,projectRole:'editor'}} tab="parameters"/>);
    expect(screen.queryByLabelText('Library type')).not.toBeInTheDocument();
    first.unmount();
    state.request.mockResolvedValue({document:{name:'Offer template'}});
    render(<DocumentWorkspacePanel {...props()} doc={{...doc,editable:false,deletable:false,projectRole:'viewer'}} tab="parameters"/>);
    expect(screen.getByText('Save changes')).toBeDisabled();
    await user.click(screen.getByText('Save a copy as template'));
    await waitFor(()=>expect(state.request).toHaveBeenCalledWith('/d/duplicate',{kind:'template'}));
});
