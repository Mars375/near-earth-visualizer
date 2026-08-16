import { NextResponse } from 'next/server'
import { fetchUpcomingApproaches } from '@/lib/nasa'

const WINDOW_DAYS = 7 // NASA NeoWs feed's own max span per request

/** Closest (by miss distance) real NASA-tracked approach in the next week —
 * a small "here's something actually happening soon" hook, using data
 * already fetched elsewhere in the app for the NEO field. */
export async function GET() {
  const today = new Date().toISOString().slice(0, 10)

  try {
    const approaches = await fetchUpcomingApproaches(today, WINDOW_DAYS)
    if (approaches.length === 0) return NextResponse.json({ approach: null })

    const closest = approaches.reduce((a, b) => (a.missDistanceKm < b.missDistanceKm ? a : b))
    return NextResponse.json({ approach: closest })
  } catch (error) {
    return NextResponse.json(
      { approach: null, error: error instanceof Error ? error.message : 'Unknown NASA API error' },
      { status: 502 },
    )
  }
}
