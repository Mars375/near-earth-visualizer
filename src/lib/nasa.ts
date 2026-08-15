export type NearEarthObject = {
  id: string
  name: string
  estimatedDiameterKm: number
  isPotentiallyHazardous: boolean
  closeApproachDate: string
  missDistanceKm: number
  relativeVelocityKmS: number
}

type NeoWsFeedResponse = {
  near_earth_objects: Record<
    string,
    Array<{
      id: string
      name: string
      estimated_diameter: {
        kilometers: { estimated_diameter_min: number; estimated_diameter_max: number }
      }
      is_potentially_hazardous_asteroid: boolean
      close_approach_data: Array<{
        close_approach_date: string
        miss_distance: { kilometers: string }
        relative_velocity: { kilometers_per_second: string }
      }>
    }>
  >
}

const NASA_API_BASE = 'https://api.nasa.gov/neo/rest/v1/feed'

/**
 * Fetches near-Earth objects for a single UTC date from NASA's NeoWs feed.
 * Falls back to the shared DEMO_KEY (30 req/hour) when NASA_API_KEY is unset.
 */
export async function fetchNearEarthObjects(date: string): Promise<NearEarthObject[]> {
  const apiKey = process.env.NASA_API_KEY ?? 'DEMO_KEY'
  const url = `${NASA_API_BASE}?start_date=${date}&end_date=${date}&api_key=${apiKey}`

  const response = await fetch(url, { next: { revalidate: 3600 } })
  if (!response.ok) {
    throw new Error(`NASA NeoWs request failed: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as NeoWsFeedResponse
  const objects = data.near_earth_objects[date] ?? []

  return objects.map((neo) => {
    const approach = neo.close_approach_data[0]
    const diameter = neo.estimated_diameter.kilometers
    return {
      id: neo.id,
      name: neo.name,
      estimatedDiameterKm:
        (diameter.estimated_diameter_min + diameter.estimated_diameter_max) / 2,
      isPotentiallyHazardous: neo.is_potentially_hazardous_asteroid,
      closeApproachDate: approach?.close_approach_date ?? date,
      missDistanceKm: approach ? Number(approach.miss_distance.kilometers) : 0,
      relativeVelocityKmS: approach
        ? Number(approach.relative_velocity.kilometers_per_second)
        : 0,
    }
  })
}
