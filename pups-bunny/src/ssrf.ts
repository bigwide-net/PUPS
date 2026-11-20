import { ClientError } from './cimd'
import type { Env } from './settings'

/**
 * SSRF protection for client metadata fetches. Edge Scripts can't restrict fetch() to
 * public addresses, so the host is resolved with DNS over HTTPS first, and refused if any
 * of its A or AAAA records is not a public address.
 *
 * Limit: fetch() resolves the name again, so a DNS server that answers differently the
 * second time (DNS rebinding) can still reach a private address. Whether Bunny's network
 * blocks private addresses itself is not documented (README, "Open questions").
 */

const DEFAULT_DOH = 'https://cloudflare-dns.com/dns-query'

const ipv4 = (s: string) => {
  const p = s.split('.').map(Number)
  return p.length == 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? p : undefined
}

/** Is an IPv4 address public? Refuses the special-purpose ranges of RFC 6890 and its successors. */
function publicV4([a, b, c]: number[]): boolean {
  return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
    a == 100 && b >= 64 && b <= 127 || a == 169 && b == 254 || a == 172 && b >= 16 && b <= 31 ||
    a == 192 && b == 168 || a == 192 && b == 0 && (c == 0 || c == 2) || a == 192 && b == 88 && c == 99 ||
    a == 198 && (b == 18 || b == 19) || a == 198 && b == 51 && c == 100 || a == 203 && b == 0 && c == 113)
}

/** Expands an IPv6 address to 8 groups. */
function groups(s: string): number[] | undefined {
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const p = ipv4(v4[1])
    if (!p) return
    s = s.slice(0, -v4[1].length) + `${(p[0] << 8 | p[1]).toString(16)}:${(p[2] << 8 | p[3]).toString(16)}`
  }
  const [head, tail, extra] = s.split('::')
  if (extra != undefined) return
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const fill = tail == undefined ? 0 : 8 - h.length - t.length
  const all = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t]
  if (all.length != 8 || all.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return
  return all.map(g => parseInt(g, 16))
}

/** Is an IPv6 address public? Only global unicast (2000::/3), minus documentation, ORCHID and mapped/translated IPv4 checked as IPv4. */
function publicV6(g: number[]): boolean {
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96): judge the embedded IPv4 address.
  if (g.slice(0, 5).every(x => !x) && g[5] == 0xffff || g[0] == 0x64 && g[1] == 0xff9b && g.slice(2, 6).every(x => !x))
    return publicV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255])
  if ((g[0] & 0xe000) != 0x2000) return false
  if (g[0] == 0x2001 && (g[1] == 0xdb8 || g[1] < 0x200)) return false
  if (g[0] == 0x2002) return publicV4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255])
  return g[0] != 0x3fff || g[1] > 0x0fff
}

export function isPublicAddress(ip: string): boolean {
  const v4 = ipv4(ip)
  if (v4) return publicV4(v4)
  const v6 = groups(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''))
  return !!v6 && publicV6(v6)
}

async function resolve(doh: string, host: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const res = await fetch(`${doh}?name=${encodeURIComponent(host)}&type=${type}`, {
    headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`DNS over HTTPS returned HTTP ${res.status}`)
  const body = await res.json() as { Status: number; Answer?: { type: number; data: string }[] }
  if (body.Status != 0 && body.Status != 3) throw new Error(`DNS error ${body.Status}`)
  return (body.Answer ?? []).filter(a => a.type == (type == 'A' ? 1 : 28)).map(a => a.data)
}

/** Throws a ClientError unless the host resolves, and only to public addresses. */
export async function assertPublicHost(host: string, env: Env): Promise<void> {
  const doh = env.DOH_URL?.trim() || DEFAULT_DOH
  if (doh == 'off') return
  let addresses: string[]
  try {
    addresses = (await Promise.all([resolve(doh, host, 'A'), resolve(doh, host, 'AAAA')])).flat()
  } catch {
    throw new ClientError(`The host ${host} of client_id could not be resolved`)
  }
  if (!addresses.length) throw new ClientError(`The host ${host} of client_id has no address`)
  if (!addresses.every(isPublicAddress)) throw new ClientError(`The host ${host} of client_id resolves to a non-public address`)
}
