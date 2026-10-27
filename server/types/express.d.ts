// Ambient augmentation of Express's Request for the JSDoc type check
// (scripts/typecheck.mjs). Types only: nothing here exists at runtime.
//
// Middleware adds these fields to every request: express-session
// (`session`, `sessionID`), multer (`file`), the body parsers' `verify` hook
// (`rawBody`), and our own auth, org and site middleware. @types/express
// declares none of them. The session is an open bag (about 40 keys across the
// OAuth, MFA and encryption flows), so it keeps an index signature; named keys
// are added as code needs a precise type.

import type { Buffer } from 'node:buffer';

declare global {
    namespace Express {
        interface Session {
            user?: { id: string; email?: string; name?: string; role?: string; orgRole?: string; organizationId?: string; /** Legacy alias of organizationId, still read as an org id. */ orgId?: string; /** Set by auth/permissionsRequireAuth.js. */ isAdmin?: boolean; /** The Nextcloud OAuth user attribute. */ 'display-name'?: string; [key: string]: unknown };
            isAdmin?: boolean;
            isAuthenticated?: boolean;
            oauthProvider?: string;
            accessToken?: string;
            refreshToken?: string;
            save(callback?: (err?: Error) => void): this;
            destroy(callback: (err?: Error) => void): this;
            regenerate(callback: (err?: Error) => void): this;
            [key: string]: any;
        }
        interface Request {
            /** Set by core/http/requestId.js. */
            id?: string;
            session: Session;
            sessionID: string;
            file?: { fieldname: string; originalname: string; mimetype: string; size: number; buffer: Buffer; path?: string; [key: string]: unknown };
            /** multer .any()/.array()/.fields(). */
            files?: Array<NonNullable<Request['file']>> | Record<string, Array<NonNullable<Request['file']>>>;
            rawBody?: string | Buffer;
            /** Set by routes/webpagesFullTierProxy.js. */
            fullTierTarget?: string;
            orgId?: string;
            primaryOrgId?: string;
            projectRole?: string;
            siteId?: string;
            /** Set by routes/ai/voice.js: the Mistral key of the caller's organisation. */
            _mistralKey?: string;
            _orgScope?: import('../auth/orgScope').OrgScope;
            user?: { id: string; email?: string; name?: string; role?: string; [key: string]: unknown };
            /** Set by attachOrgFilter (usage monitoring); the filters a query is scoped by. */
            usageFilters?: { userId?: string; organizationId?: string; excludeDryRun?: boolean; [key: string]: unknown };
            /** Set by requirePreviewToken (auth/webpagePreviewToken.js). */
            previewClaims?: { userId: string; webpageId: string; viewerUserId?: string };
            /** Set by requireShareBridgeToken (routes/publicShareBridge.js). */
            shareBridgeClaims?: { shareId: string; webpageId: string };
            /** The organisation row whose connector signature verified (routes/nextcloudTaskProcessing.js). */
            connectorOrg?: { id?: string; [key: string]: unknown };
            /** Set by requireNotebookRole (routes/notebooksAccess.js): the notebook with the caller's role. */
            notebook?: { id: string; userId?: string; role?: string; projectId?: string | null; [key: string]: unknown };
            notebookRole?: string;
            /** Set by the library `:id` param loader (routes/mcpLibrary.js). */
            libraryRow?: object;
            /** The organisation an admin request is scoped to (routes/feedback.js). */
            scopedOrgId?: string;
            /** Set by projects/stages/stageAuth.js. */
            stageCtx?: import('../routes/projects/stages/deploymentRoutes').StageCtx;
            /** The organisation an admin route resolved from `:orgId` (routes/admin). */
            org?: { id?: string; [key: string]: unknown };
        }
    }
}

declare module 'node:http' {
    interface IncomingMessage {
        rawBody?: string | Buffer;
        /** Set by routes/webpagesFullTierProxy.js on the upgrade path. */
        fullTierTarget?: string;
    }
}

export {};
