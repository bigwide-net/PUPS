import { escapeHtml as h } from './html'
import { visible } from './sanitize'
import { t } from './texts'

/**
 * Is a normalized path (or scope prefix) private (RFC-6 "Private areas")? Paths in /pups/private/
 * and in an app's /appdata/<client-host>/private/. Case-insensitive: on a case-insensitive disk,
 * /APPDATA/x/PRIVATE/a.json is the same file.
 */
export const isPrivate = (path: string) => /^\/(pups\/private\/|appdata\/[^/]+\/private\/[^/])/i.test(path)

/** A declared well-known path, as far as the owner pages need it. */
export interface WellKnownView {
  path: string
  rels: string[]
  properties: string[]
  /** How the consent screen names the path, e.g. "your feed". */
  description?: string
}

/** A scope that covers paths: a write scope, or a read scope for a private path. */
export type PathScopeView = { kind: 'write' | 'read'; prefix: string; wellKnown?: WellKnownView }
/**
 * A parsed scope. Without `wellKnown`, a path scope is the app's own directory. `identity-tokens` lets the app act as the
 * owner on other sites (RFC-10).
 */
export type ScopeView = { kind: 'identify' } | { kind: 'identity-tokens' } | PathScopeView

const FEED_PATHS = ['/feed.json', '/feed/', '/.well-known/following.opml']
/** The groups with path scopes, in the order of the consent screen. */
const PATH_GROUPS = ['appdata', 'feeds', 'profile', 'private'] as const

/** The consent screen's group of a scope (RFC-6 "Consent", RFC-10 "Scope and consent"). */
export const scopeGroup = (sc: ScopeView) => sc.kind == 'identify' ? 'identity' : sc.kind == 'identity-tokens' ? 'actAs' : !sc.wellKnown ? 'appdata'
  : isPrivate(sc.wellKnown.path) ? 'private' : FEED_PATHS.includes(sc.wellKnown.path) ? 'feeds' : 'profile'

/** The group of `identity-tokens`, after the path groups, with what it means in its details. */
const actAsLabel = (ownerHost: string) => t('group.actAs', { me: `<strong>${h(ownerHost)}</strong>` })
const actAsDetails = () => `<details>
<summary>${t('details.summary')}</summary>
<p>${t('details.actAs')}</p>
</details>`

/** What a scope covers, for the details of its group. In /pups/private/, also what the app may do there. */
function scopeItem(sc: PathScopeView): string {
  const code = `<code>${h(visible(sc.prefix))}</code>`, e = sc.wellKnown
  if (!e) return t('scope.ownFolder', { path: code })
  const what = sc.prefix == e.path && e.description ? t('scope.named', { name: h(visible(e.description)), path: code })
    : sc.prefix.endsWith('/') ? t('scope.filesUnder', { path: code }) : code
  return !isPrivate(e.path) ? what : t(sc.kind == 'read' ? 'scope.read' : 'scope.readWrite', { what })
}

/** Scopes by their consent screen group, in the order of the scopes. */
function groupScopes(scopes: Iterable<[string, ScopeView]>) {
  const groups = new Map<string, [string, ScopeView][]>()
  for (const [str, sc] of scopes) groups.set(scopeGroup(sc), [...groups.get(scopeGroup(sc)) ?? [], [str, sc]])
  return groups
}

/** A group's name. Private data that the app may only read is "read", not "manage". */
const groupLabel = (g: typeof PATH_GROUPS[number], scopes: PathScopeView[]) =>
  t(g == 'private' && scopes.every(sc => sc.kind == 'read') ? 'group.privateRead' : `group.${g}`)

/** The collapsed details of a group of scopes: what they cover, and the rels and properties they allow. */
function groupDetails(g: string, scopes: PathScopeView[]): string {
  const list = (xs: string[]) => [...new Set(xs)].map(x => `<code>${h(visible(x))}</code>`).join(', ')
  // Rels and properties come with a scope for the whole declared path.
  const whole = scopes.filter(sc => sc.prefix == sc.wellKnown?.path).map(sc => sc.wellKnown!)
  const rels = whole.flatMap(e => e.rels), props = whole.flatMap(e => e.properties)
  return `<details>
<summary>${t('details.summary')}</summary>
${g == 'private' ? '' : `<p>${t('details.write')}</p>\n`}<ul>
${scopes.map(sc => `<li>${scopeItem(sc)}</li>`).join('\n')}
</ul>
${rels.length ? `<p>${t('details.rels', { list: list(rels) })}</p>\n` : ''}${
    props.length ? `<p>${t('details.properties', { list: list(props) })}</p>\n` : ''}</details>`
}

const scopesOf = (entries: [string, ScopeView][]) => entries.map(([, sc]) => sc as PathScopeView)
const pathGroups = (groups: Map<string, [string, ScopeView][]>) => PATH_GROUPS.filter(g => groups.has(g))

/**
 * The permissions of the consent screen: identity, then one checkbox per group, which grants
 * all of the group's scopes. The paths, rels and properties are in a collapsed details element.
 */
export function permissionGroups(scopes: Map<string, ScopeView>, ownerHost: string): string {
  const groups = groupScopes(scopes)
  return [
    `<label><input type="checkbox" checked disabled> <span>${t('group.identity', { me: `<strong>${h(ownerHost)}</strong>` })}</span></label>`
      + (groups.has('identity') ? '\n<input type="hidden" name="scope" value="identify">' : ''),
    ...pathGroups(groups).map(g => `<div>
<label><input type="checkbox" name="scope" value="${h(groups.get(g)!.map(([str]) => str).join(' '))}" checked> <span>${groupLabel(g, scopesOf(groups.get(g)!))}</span></label>
${groupDetails(g, scopesOf(groups.get(g)!))}
</div>`),
    ...groups.has('actAs') ? [`<div>
<label><input type="checkbox" name="scope" value="identity-tokens" checked> <span>${actAsLabel(ownerHost)}</span></label>
${actAsDetails()}
</div>`] : [],
  ].join('\n')
}

/**
 * A grant's permissions on the apps page, grouped as on the consent screen. Scopes that no
 * longer parse (e.g. a well-known path that was removed from the configuration) are listed as they are.
 */
export function permissionList(scopes: [string, ScopeView | undefined][], ownerHost: string): string {
  const groups = groupScopes(scopes.filter((x): x is [string, ScopeView] => !!x[1]))
  return `<ul>
${[
    ...groups.has('identity') ? [`<li>${t('group.identity', { me: `<strong>${h(ownerHost)}</strong>` })}</li>`] : [],
    ...pathGroups(groups).map(g => `<li>${groupLabel(g, scopesOf(groups.get(g)!))}\n${groupDetails(g, scopesOf(groups.get(g)!))}</li>`),
    ...groups.has('actAs') ? [`<li>${actAsLabel(ownerHost)}\n${actAsDetails()}</li>`] : [],
    ...scopes.filter(([, sc]) => !sc).map(([str]) => `<li><code>${h(visible(str))}</code></li>`),
  ].join('\n')}
</ul>`
}
