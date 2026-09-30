import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProjectWorkspacePage from './src/components/projects/workspace/ProjectWorkspacePage';
import './src/index.css';
import { setCurrentUser } from './src/utils/scopedStorage';
setCurrentUser('u-owner');
const qc = new QueryClient({defaultOptions:{queries:{retry:false}}});
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={qc}><div style={{height:'100dvh'}}><ProjectWorkspacePage projectId="p1" user={{id:'u-owner',name:'Olivia Owner'}} initialTab={new URLSearchParams(location.search).get('tab') || 'overview'} onClose={()=>{}} onNavigate={()=>{}} onStartChat={()=>{}} onOpenThread={()=>{}} /></div></QueryClientProvider>);
