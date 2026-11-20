import express from 'express';
import { appsPage, unlockPage } from 'pups-ui';
import { Ctx } from '../lib/context';
import { htmlErrors, ownerSite, PASSWORD_ONLY, send } from '../lib/html';
import { field, LIMITS } from '../lib/http';
import { log } from '../lib/log';
import { appdataPrefix } from '../lib/paths';
import { modifyHostMeta, onGrantRevoked, ownerHostMeta } from './hostmeta';
import { permissionList } from './oauth';


/** The apps page: the grants, and the links and properties of host-meta.json, each with a button that removes it. */
function listPage(res: express.Response, ctx: Ctx, o: { message?: string; error?: string } = {}) {
    const { config } = ctx;
    const hostMeta = ownerHostMeta(ctx);
    return send(res, appsPage(ownerSite(config), {
        apps: ctx.state.activeGrants().map(g => ({
            ...g, lastUsedAt: g.lastUsedAt ?? null, permissions: permissionList(g.scope, g.clientHost, config),
            hasFiles: g.scope.split(' ').includes(`write:${appdataPrefix(g.clientHost)}`),
        })),
        links: (hostMeta.doc.links ?? []).map(l => ({ rel: String(l.rel), href: String(l.href ?? '') })),
        properties: Object.entries(hostMeta.doc.properties ?? {}).map(([k, v]) => [k, String(v)]),
        hostMetaError: hostMeta.error, hostMetaStored: hostMeta.stored, confirm: PASSWORD_ONLY, ...o,
    }));
}

/** Removes a grant, and with `deleteFiles` the files in its own directory. Returns the message for the page. */
function revoke(ctx: Ctx, id: string, deleteFiles: boolean): string {
    const g = ctx.state.revokeGrant(id);
    if (!g)
        return 'The app had already been removed.';
    log('grant.revoked-by-owner', { client: g.clientId, grant: g.id, scope: g.scope, deleteFiles });
    onGrantRevoked(g.clientId, ctx);
    if (deleteFiles)
        ctx.files.deleteDir(appdataPrefix(g.clientHost));
    return `${g.clientHost} can no longer write to your domain.${deleteFiles ? ' Its files were deleted.' : ''}`;
}

/**
 * /pups/apps: the grants and host-meta.json, with buttons that remove them. Without cookies,
 * viewing and every change are each confirmed with the password (RFC-6 "Deployment modes",
 * "Owner authentication"); a failed check shows nothing but the password form again.
 */
export function adminRoutes(ctx: Ctx): express.Router {
    const router = express.Router();
    const site = ownerSite(ctx.config);
    router.get('/pups/apps', htmlErrors((_req, res) => send(res, unlockPage(site, PASSWORD_ONLY))));
    router.post('/pups/apps', express.urlencoded({ extended: false, limit: '64kb' }), htmlErrors((req, res) => {
        const f = (name: string, max?: number) => field(req.body, name, max);
        const grant = f('revoke') ?? f('revoke_delete'), link = f('remove_link', LIMITS.url * 2), property = f('remove_property', LIMITS.url);
        const action = grant ? 'remove app' : link ? 'remove link' : property ? 'remove property' : 'view apps page';
        const err = ctx.owner.check(f('password', LIMITS.password), action);
        if (err)
            return send(res, unlockPage(site, PASSWORD_ONLY, action == 'view apps page' ? err : `${err} Nothing was changed.`));
        if (grant)
            return listPage(res, ctx, { message: revoke(ctx, grant, !!f('revoke_delete')) });
        if (link) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(link);
            } catch {}
            if (!Array.isArray(parsed) || parsed.length != 2 || parsed.some(x => typeof x != 'string'))
                return listPage(res, ctx, { error: 'Invalid link.' });
            const [rel, href] = parsed as [string, string];
            modifyHostMeta(ctx, doc => {
                const before = doc.links?.length ?? 0;
                doc.links = doc.links?.filter(l => !(l.rel == rel && (l.href ?? '') == href));
                return (doc.links?.length ?? 0) != before;
            }, false);
            log('host-meta.link-removed-by-owner', { rel, href });
            return listPage(res, ctx, { message: 'The link was removed.' });
        }
        if (property) {
            modifyHostMeta(ctx, doc => {
                if (!doc.properties || !(property in doc.properties))
                    return false;
                delete doc.properties[property];
                return true;
            }, false);
            log('host-meta.property-removed-by-owner', { property });
            return listPage(res, ctx, { message: 'The property was removed.' });
        }
        return listPage(res, ctx);
    }));
    return router;
}
