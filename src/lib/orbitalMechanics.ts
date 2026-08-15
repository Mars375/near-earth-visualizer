export type OrbitalElements = {
  semiMajorAxisAu: number
  eccentricity: number
  inclinationDeg: number
  ascendingNodeDeg: number
  perihelionArgumentDeg: number
  meanAnomalyDeg: number
  meanMotionDegPerDay: number
  epochJulianDate: number
}

export type Vec3 = { x: number; y: number; z: number }

/** Earth's real orbit is nearly circular (e = 0.0167); simplified to a
 * perfect circle at 1 AU using its actual J2000 mean-longitude reference,
 * which keeps Earth's heliocentric direction accurate to a couple of
 * degrees without needing the full elliptical solve for a body this close
 * to circular. */
const EARTH_MEAN_LONGITUDE_J2000_DEG = 100.46435
const EARTH_MEAN_MOTION_DEG_PER_DAY = 0.98560912
const J2000_JULIAN_DATE = 2451545.0

export function unixMsToJulianDate(unixMs: number): number {
  return unixMs / 86400000 + 2440587.5
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Newton-Raphson solve of Kepler's equation M = E - e sin(E) for E. */
function solveEccentricAnomaly(meanAnomalyRad: number, eccentricity: number): number {
  let E = meanAnomalyRad
  for (let i = 0; i < 8; i += 1) {
    const delta = E - eccentricity * Math.sin(E) - meanAnomalyRad
    const derivative = 1 - eccentricity * Math.cos(E)
    E -= delta / derivative
  }
  return E
}

/** Classical orbital elements -> heliocentric ecliptic Cartesian position, in AU. */
export function heliocentricPosition(elements: OrbitalElements, julianDate: number): Vec3 {
  const daysSinceEpoch = julianDate - elements.epochJulianDate
  const meanAnomalyDeg = normalizeDeg(
    elements.meanAnomalyDeg + elements.meanMotionDegPerDay * daysSinceEpoch,
  )
  const M = degToRad(meanAnomalyDeg)
  const e = elements.eccentricity
  const E = solveEccentricAnomaly(M, e)

  const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2))
  const radius = elements.semiMajorAxisAu * (1 - e * Math.cos(E))

  const xPerifocal = radius * Math.cos(trueAnomaly)
  const yPerifocal = radius * Math.sin(trueAnomaly)

  const omega = degToRad(elements.perihelionArgumentDeg)
  const inclination = degToRad(elements.inclinationDeg)
  const node = degToRad(elements.ascendingNodeDeg)

  const cosO = Math.cos(node)
  const sinO = Math.sin(node)
  const cosW = Math.cos(omega)
  const sinW = Math.sin(omega)
  const cosI = Math.cos(inclination)
  const sinI = Math.sin(inclination)

  const x =
    (cosO * cosW - sinO * sinW * cosI) * xPerifocal + (-cosO * sinW - sinO * cosW * cosI) * yPerifocal
  const y =
    (sinO * cosW + cosO * sinW * cosI) * xPerifocal + (-sinO * sinW + cosO * cosW * cosI) * yPerifocal
  const z = sinW * sinI * xPerifocal + cosW * sinI * yPerifocal

  return { x, y, z }
}

export function earthHeliocentricPosition(julianDate: number): Vec3 {
  const daysSinceJ2000 = julianDate - J2000_JULIAN_DATE
  const positionAngleDeg = normalizeDeg(
    EARTH_MEAN_LONGITUDE_J2000_DEG + EARTH_MEAN_MOTION_DEG_PER_DAY * daysSinceJ2000,
  )
  const angle = degToRad(positionAngleDeg)
  return { x: Math.cos(angle), y: 0, z: Math.sin(angle) }
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
