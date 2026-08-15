import { NextResponse } from 'next/server'
import { fetchNearEarthObjects } from '@/lib/nasa'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get('date') ?? new Date().toISOString().slice(0, 10)

  try {
    const objects = await fetchNearEarthObjects(date)
    return NextResponse.json({ date, objects })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown NASA API error' },
      { status: 502 },
    )
  }
}
