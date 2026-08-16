const CELESTRAK_TLE = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle'

// Celestrak's Starlink group alone is 6000+ satellites — real count, but
// rendering all of them would be wasted GPU work on a phone for a dot field
// whose whole point is "there are a lot of these," not an exact census.
// Capped to a sampled subset; still real TLE data, just not exhaustive.
const MAX_SATELLITES = 1500

// Celestrak refuses re-downloads of a group within its own 2h update cycle
// (returns 403 "GP data has not updated since your last successful
// download"), so every request MUST be served from this in-process cache —
// hitting the upstream URL per client request gets us blocked outright.
// ponytail: module-scope cache, not shared across server instances — fine
// for a single dev/small deploy, swap for a real cache store if this ever
// runs behind multiple server processes.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000
let cache: { satellites: TleEntry[]; fetchedAt: number } | null = null

export type TleEntry = { name: string; line1: string; line2: string }

async function fetchFreshSatellites(): Promise<TleEntry[]> {
  const response = await fetch(CELESTRAK_TLE, { cache: 'no-store' })
  if (!response.ok) throw new Error(`celestrak ${response.status}`)

  const text = await response.text()
  const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean)

  const satellites: TleEntry[] = []
  for (let i = 0; i + 2 < lines.length && satellites.length < MAX_SATELLITES; i += 3) {
    satellites.push({ name: lines[i].trim(), line1: lines[i + 1], line2: lines[i + 2] })
  }
  return satellites
}

/**
 * Proxies Celestrak's public Starlink TLE (two-line element) set — real
 * orbital state vectors, propagated client-side with satellite.js/SGP4 to
 * get live positions. No API key needed; Celestrak is a free public catalog,
 * but it rate-limits re-downloads of the same group, hence the server cache.
 */
export async function GET() {
  const isStale = !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS

  if (isStale) {
    try {
      const satellites = await fetchFreshSatellites()
      cache = { satellites, fetchedAt: Date.now() }
    } catch {
      // Upstream refused/unreachable — fall through to serve a stale cache
      // if we have one, rather than an empty field.
    }
  }

  if (!cache) {
    return Response.json({ satellites: [], error: 'celestrak unreachable' }, { status: 502 })
  }

  return Response.json(
    { satellites: cache.satellites },
    { headers: { 'Cache-Control': 'public, max-age=21600' } },
  )
}
