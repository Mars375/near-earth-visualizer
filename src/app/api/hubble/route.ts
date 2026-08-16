const CELESTRAK_TLE = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=20580&FORMAT=tle'

// Same 2h Celestrak rate limit as /api/satellites — see that route for the
// full explanation. Single object here, but the caching need is identical.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000
let cache: { line1: string; line2: string; fetchedAt: number } | null = null

async function fetchFreshTle(): Promise<{ line1: string; line2: string }> {
  const response = await fetch(CELESTRAK_TLE, { cache: 'no-store' })
  if (!response.ok) throw new Error(`celestrak ${response.status}`)

  const lines = (await response.text()).split('\n').map((l) => l.trimEnd()).filter(Boolean)
  // First line is the object name; TLE proper is the next two.
  if (lines.length < 3) throw new Error('unexpected TLE response shape')
  return { line1: lines[1], line2: lines[2] }
}

/**
 * Real TLE for Hubble (NORAD 20580) via Celestrak — propagated client-side
 * with the same satellite.js/SGP4 pipeline as the Starlink field, just for
 * one object instead of thousands.
 */
export async function GET() {
  const isStale = !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS

  if (isStale) {
    try {
      const tle = await fetchFreshTle()
      cache = { ...tle, fetchedAt: Date.now() }
    } catch {
      // Upstream refused/unreachable — fall through to a stale cache if any.
    }
  }

  if (!cache) {
    return Response.json({ tle: null, error: 'celestrak unreachable' }, { status: 502 })
  }

  return Response.json(
    { tle: { line1: cache.line1, line2: cache.line2 } },
    { headers: { 'Cache-Control': 'public, max-age=21600' } },
  )
}
