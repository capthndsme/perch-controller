/**
 * Small WireGuard rules of the VPN page (design gateway-sync dashboard.md 4):
 * reading a provider's `.conf`, and the defaults of a new server (the first
 * free name, port and 10.x.0.0/24 subnet).
 */

export type WgConfFile = {
  privateKey: string | null
  addresses: string[]
  dns: string[]
  mtu: number | null
  peer: {
    publicKey: string | null
    presharedKey: boolean
    allowedIps: string[]
    endpoint: { host: string; port: number } | null
    keepalive: number | null
  } | null
}

const list = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

/** `host:port`, `[v6]:port`. */
function endpointOf(value: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:\s]+):(\d+)$/.exec(value)
  if (!m) return null
  const port = Number(m[2])
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null
}

/**
 * Parses a wg-quick config: `[Interface]` and the first `[Peer]`. Comments
 * and unknown keys are ignored; nothing leaves the browser from here.
 */
export function parseWgConf(text: string): WgConfFile {
  const out: WgConfFile = { privateKey: null, addresses: [], dns: [], mtu: null, peer: null }
  let section: 'interface' | 'peer' | 'other' | null = null
  let peers = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim()
    if (!line) continue
    const head = /^\[(\w+)\]$/.exec(line)
    if (head) {
      const name = head[1].toLowerCase()
      if (name === 'peer') {
        peers += 1
        section = peers === 1 ? 'peer' : 'other'
        if (peers === 1) {
          out.peer = { publicKey: null, presharedKey: false, allowedIps: [], endpoint: null, keepalive: null }
        }
      } else {
        section = name === 'interface' ? 'interface' : 'other'
      }
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (section === 'interface') {
      if (key === 'privatekey') out.privateKey = value
      else if (key === 'address') out.addresses.push(...list(value))
      else if (key === 'dns') out.dns.push(...list(value))
      else if (key === 'mtu') out.mtu = Number(value) || null
    } else if (section === 'peer' && out.peer) {
      if (key === 'publickey') out.peer.publicKey = value
      else if (key === 'presharedkey') out.peer.presharedKey = true
      else if (key === 'allowedips') out.peer.allowedIps.push(...list(value))
      else if (key === 'endpoint') out.peer.endpoint = endpointOf(value)
      else if (key === 'persistentkeepalive') out.peer.keepalive = Number(value) || null
    }
  }
  return out
}

/** A WireGuard key: 32 bytes of base64 (44 characters). */
export function isWgKey(value: string): boolean {
  return /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(value.trim())
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!/^\d{1,3}$/.test(p) || v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** `10.7.0.1/24` → start and length, or null when not IPv4. */
function cidr4(value: string): { base: number; len: number } | null {
  const [ip, len = '32'] = value.split('/')
  const n = ipv4ToInt(ip)
  const l = Number(len)
  if (n === null || !Number.isInteger(l) || l < 0 || l > 32) return null
  return { base: n, len: l }
}

function overlaps(a: { base: number; len: number }, b: { base: number; len: number }): boolean {
  const len = Math.min(a.len, b.len)
  const size = 2 ** (32 - len)
  return Math.floor(a.base / size) === Math.floor(b.base / size)
}

/** The first `10.x.0.1/24` (x from 7) that overlaps none of `used`. */
export function freeSubnet(used: string[]): string {
  const taken = used.map(cidr4).filter((c): c is NonNullable<typeof c> => c !== null)
  for (let x = 7; x < 255; x += 1) {
    const candidate = { base: ipv4ToInt(`10.${x}.0.0`)!, len: 24 }
    if (!taken.some((t) => overlaps(t, candidate))) return `10.${x}.0.1/24`
  }
  return '10.7.0.1/24'
}

export function freeName(used: string[]): string {
  for (let n = 0; n < 100; n += 1) if (!used.includes(`wg${n}`)) return `wg${n}`
  return 'wg0'
}

export function freePort(used: Array<number | null>): number {
  for (let port = 51820; port < 51920; port += 1) if (!used.includes(port)) return port
  return 51820
}

/** Saves a text as a file (the one-time client config), without keeping a copy. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
