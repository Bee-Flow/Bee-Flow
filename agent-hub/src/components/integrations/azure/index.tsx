// The organisation's Microsoft 365 page (Microsoft365Panel). The instance-wide
// Azure form that lived here (Azure OpenAI, chat tiers, document processing,
// Microsoft SSO) is gone: each of those settings has one home, in AI
// configuration (the Azure provider and the chat model tiers), Platform services
// (Document Intelligence and embeddings) and Sign-in & SSO (the Microsoft app).
export { default } from './Microsoft365Panel';
