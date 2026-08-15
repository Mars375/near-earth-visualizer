import { NextResponse } from 'next/server'

type WhereTheIssResponse = {
  latitude: number
  longitude: number
  altitude: number
  velocity: number
}

export async function GET() {
  try {
    const response = await fetch('https://api.wheretheiss.at/v1/satellites/25544', {
      next: { revalidate: 10 },
    })
    if (!response.ok) {
      throw new Error(`wheretheiss.at request failed: ${response.status}`)
    }
    const data = (await response.json()) as WhereTheIssResponse
    return NextResponse.json({
      latitude: data.latitude,
      longitude: data.longitude,
      altitudeKm: data.altitude,
      velocityKmH: data.velocity,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown ISS tracking error' },
      { status: 502 },
    )
  }
}
