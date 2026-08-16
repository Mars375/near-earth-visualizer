import type { OrbitalElements } from './orbitalMechanics'

export type NearEarthObject = {
  id: string
  name: string
  estimatedDiameterKm: number
  isPotentiallyHazardous: boolean
  closeApproachDate: string
  missDistanceKm: number
  relativeVelocityKmS: number
  orbit: OrbitalElements | null
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

type NeoWsLookupResponse = {
  orbital_data: {
    semi_major_axis: string
    eccentricity: string
    inclination: string
    ascending_node_longitude: string
    perihelion_argument: string
    mean_anomaly: string
    mean_motion: string
    epoch_osculation: string
  }
}

const NASA_API_BASE = 'https://api.nasa.gov/neo/rest/v1'

function apiKey(): string {
  return process.env.NASA_API_KEY ?? 'DEMO_KEY'
}

/** One lookup call per object — real orbital elements, not just the close-approach summary. */
async function fetchOrbitalElements(id: string): Promise<OrbitalElements | null> {
  try {
    const response = await fetch(`${NASA_API_BASE}/neo/${id}?api_key=${apiKey()}`, {
      next: { revalidate: 86400 },
    })
    if (!response.ok) return null
    const data = (await response.json()) as NeoWsLookupResponse
    const o = data.orbital_data
    return {
      semiMajorAxisAu: Number(o.semi_major_axis),
      eccentricity: Number(o.eccentricity),
      inclinationDeg: Number(o.inclination),
      ascendingNodeDeg: Number(o.ascending_node_longitude),
      perihelionArgumentDeg: Number(o.perihelion_argument),
      meanAnomalyDeg: Number(o.mean_anomaly),
      meanMotionDegPerDay: Number(o.mean_motion),
      epochJulianDate: Number(o.epoch_osculation),
    }
  } catch {
    return null
  }
}

/**
 * Fetches near-Earth objects for a single UTC date from NASA's NeoWs feed,
 * then fetches each object's real heliocentric orbital elements via the
 * per-object lookup endpoint (needs a real NASA_API_KEY — DEMO_KEY's 30
 * req/hour limit can't cover a day's worth of objects).
 */
export type UpcomingApproach = {
  name: string
  date: string
  missDistanceKm: number
  isPotentiallyHazardous: boolean
}

/**
 * Feed-only summary across a multi-day window (no per-object orbital
 * lookup — that's only needed to actually plot an orbit, not for a
 * one-line "closest approach this week" stat).
 */
export async function fetchUpcomingApproaches(startDate: string, days: number): Promise<UpcomingApproach[]> {
  const end = new Date(`${startDate}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + days - 1)
  const endDate = end.toISOString().slice(0, 10)

  const url = `${NASA_API_BASE}/feed?start_date=${startDate}&end_date=${endDate}&api_key=${apiKey()}`
  const response = await fetch(url, { next: { revalidate: 3600 } })
  if (!response.ok) {
    throw new Error(`NASA NeoWs request failed: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as NeoWsFeedResponse
  const approaches: UpcomingApproach[] = []
  for (const dayObjects of Object.values(data.near_earth_objects)) {
    for (const neo of dayObjects) {
      const approach = neo.close_approach_data[0]
      if (!approach) continue
      approaches.push({
        name: neo.name,
        date: approach.close_approach_date,
        missDistanceKm: Number(approach.miss_distance.kilometers),
        isPotentiallyHazardous: neo.is_potentially_hazardous_asteroid,
      })
    }
  }
  return approaches
}

/**
 * `days`: a single day's feed is often just 0-2 objects — not much of a
 * "field" to look at or tap on. Defaults to a 3-day window (still well
 * within a real API key's hourly quota, given each object costs one more
 * lookup call below) for a noticeably fuller scene.
 */
export async function fetchNearEarthObjects(date: string, days = 3): Promise<NearEarthObject[]> {
  const end = new Date(`${date}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + days - 1)
  const endDate = end.toISOString().slice(0, 10)

  const url = `${NASA_API_BASE}/feed?start_date=${date}&end_date=${endDate}&api_key=${apiKey()}`

  const response = await fetch(url, { next: { revalidate: 3600 } })
  if (!response.ok) {
    throw new Error(`NASA NeoWs request failed: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as NeoWsFeedResponse
  const objects = Object.values(data.near_earth_objects).flat()

  return Promise.all(
    objects.map(async (neo) => {
      const approach = neo.close_approach_data[0]
      const diameter = neo.estimated_diameter.kilometers
      const orbit = await fetchOrbitalElements(neo.id)
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
        orbit,
      }
    }),
  )
}
