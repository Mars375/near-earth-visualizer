export type SpaceObjectType = 'asteroid' | 'satellite' | 'station' | 'shuttle'

export type IssPosition = {
  latitude: number
  longitude: number
  altitudeKm: number
  velocityKmH: number
}

const EARTH_RADIUS_KM = 6371

/** Converts a lat/lon/altitude fix into a scene-space position around the unit-radius Earth mesh. */
export function latLonAltToPosition(
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeKm: number,
): [number, number, number] {
  const lat = (latitudeDeg * Math.PI) / 180
  const lon = (longitudeDeg * Math.PI) / 180
  const radius = 1 + altitudeKm / EARTH_RADIUS_KM

  return [
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * Math.cos(lat) * Math.sin(lon),
  ]
}
