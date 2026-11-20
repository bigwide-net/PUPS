import express from 'express';
import path from 'path';
import { errorPage, OwnerSite } from 'pups-ui';
import { PupsConfig } from './config';
import { HttpError } from './http';
import { noteError } from './log';

/**
 * The owner pages come from pups-ui, shared with the other TypeScript implementations, as
 * fetch Responses; this file sends them with Express and serves their stylesheet and script.
 */

/** What the owner pages need to know about this installation. This server runs in same-domain mode only. */
export const ownerSite = (c: PupsConfig): OwnerSite => ({ ownerHost: c.host, ownerOrigin: c.origin, subdomainMode: false });

/** The owner confirms every action with the password from PUPS_PASSWORD; there are no passkeys. */
export const PASSWORD_ONLY = { hasPassword: true };

/** Sends a page from pups-ui. */
export async function send(res: express.Response, page: Response) {
    res.status(page.status).set(Object.fromEntries(page.headers)).send(await page.text());
}

export function sendErrorPage(res: express.Response, title: string, message: string, status = 400) {
    noteError(res, title, message);
    return send(res, errorPage(title, message, status));
}

/** Runs an owner-page handler; request errors (e.g. oversized values) become an HTML error page instead of JSON. */
export const htmlErrors = (handler: (req: express.Request, res: express.Response) => unknown): express.RequestHandler =>
    async (req, res) => {
        try {
            await handler(req, res);
        } catch (e) {
            if (!(e instanceof HttpError))
                throw e;
            await sendErrorPage(res, 'Invalid request', e.message, e.status);
        }
    };

/** /pups/assets/: the stylesheet and script of the owner pages, from pups-ui. */
export const assetRoutes = () => express.Router().use('/pups/assets', express.static(
    path.dirname(require.resolve('pups-ui/public/pups/assets/owner.css')),
    { index: false, dotfiles: 'ignore', setHeaders: res => res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=300' }) },
));
