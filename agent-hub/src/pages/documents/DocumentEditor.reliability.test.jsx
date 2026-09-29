import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state=vi.hoisted(()=>({dirty:null,bridgeHtml:null,api:{getDocument:vi.fn(),updateDocument:vi.fn(),downloadPdf:vi.fn(),listVersions:vi.fn(),restoreVersion:vi.fn(),createDocument:vi.fn(),documentRequest:vi.fn()}}));
vi.mock('./documentsApi',()=>state.api);
vi.mock('../../hooks/useTranslation',()=>({default:()=>({t:(_k,fb)=>fb,locale:'en'})}));
vi.mock('./DocumentWorkspacePanel',()=>({default:()=>null}));
vi.mock('./DocumentCanvas',async()=>{
    const {forwardRef,useImperativeHandle}=await import('react');
    return {default:forwardRef(function Canvas({onDirty},ref){
        state.dirty=onDirty;
        useImperativeHandle(ref,()=>({flush:async()=>{if(state.bridgeHtml)onDirty(state.bridgeHtml);}}));
        return <div data-testid="canvas"/>;
    })};
});
import DocumentEditor from './DocumentEditor';
const doc={id:'d',versionId:'v1',name:'Policy',bodyHtml:'<p>Original</p>',css:'',settings:{},editable:true};
beforeEach(()=>{
    sessionStorage.clear();state.bridgeHtml=null;vi.clearAllMocks();
    state.api.getDocument.mockResolvedValue(doc);
    state.api.updateDocument.mockImplementation(async(_id,patch)=>({...doc,...patch,versionId:'v2'}));
    state.api.downloadPdf.mockResolvedValue({degraded:false});
    state.api.listVersions.mockResolvedValue([]);
});
afterEach(cleanup);
async function open(props={}){render(<DocumentEditor documentId="d" onBack={()=>{}} {...props}/>);await screen.findByTestId('canvas');}
describe('document save ordering',()=>{
    it('flushes text still inside the iframe before exporting',async()=>{
        await open();state.bridgeHtml='<p>Just typed</p>';
        fireEvent.click(screen.getByTestId('document-download-pdf'));
        await waitFor(()=>expect(state.api.downloadPdf).toHaveBeenCalledOnce());
        expect(state.api.updateDocument).toHaveBeenCalledWith('d',{bodyHtml:'<p>Just typed</p>',expectedVersionId:'v1'});
        expect(state.api.updateDocument.mock.invocationCallOrder[0]).toBeLessThan(state.api.downloadPdf.mock.invocationCallOrder[0]);
    });
    it('blocks export on save failure and retains the draft for recovery',async()=>{
        await open();state.bridgeHtml='<p>Unsaved</p>';state.api.updateDocument.mockRejectedValue(new Error('offline'));
        fireEvent.click(screen.getByTestId('document-download-pdf'));
        await screen.findByText('offline');
        expect(state.api.downloadPdf).not.toHaveBeenCalled();
        expect(sessionStorage.getItem('document-draft:d')).toBe('<p>Unsaved</p>');
    });
    it('saves the newest edit after an in-flight save without racing revisions',async()=>{
        await open();let finish;
        state.api.updateDocument.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
        act(()=>state.dirty('<p>First</p>'));
        fireEvent.click(screen.getByTestId('document-download-pdf'));
        await waitFor(()=>expect(state.api.updateDocument).toHaveBeenCalledOnce());
        act(()=>state.dirty('<p>Second</p>'));
        await act(async()=>finish({...doc,bodyHtml:'<p>First</p>',versionId:'v2'}));
        await waitFor(()=>expect(state.api.downloadPdf).toHaveBeenCalledOnce());
        expect(state.api.updateDocument).toHaveBeenNthCalledWith(2,'d',{bodyHtml:'<p>Second</p>',expectedVersionId:'v2'});
    });
    it('does not replace a newer pending edit with the failed older request',async()=>{
        await open();let reject;
        state.api.updateDocument.mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;}));
        act(()=>state.dirty('<p>Old</p>'));fireEvent.click(screen.getByTestId('document-download-pdf'));
        await waitFor(()=>expect(state.api.updateDocument).toHaveBeenCalledOnce());
        act(()=>state.dirty('<p>Newest</p>'));
        await act(async()=>reject(new Error('conflict')));
        expect(sessionStorage.getItem('document-draft:d')).toBe('<p>Newest</p>');
        expect(state.api.downloadPdf).not.toHaveBeenCalled();
    });
    it('waits for saving before closing the document',async()=>{
        const onBack=vi.fn();await open({onBack});state.bridgeHtml='<p>Before leaving</p>';
        fireEvent.click(screen.getByLabelText('Back to Documents'));
        await waitFor(()=>expect(onBack).toHaveBeenCalledOnce());
        expect(state.api.updateDocument.mock.invocationCallOrder[0]).toBeLessThan(onBack.mock.invocationCallOrder[0]);
    });
});
