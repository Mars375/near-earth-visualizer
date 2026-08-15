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

export const J2000_JULIAN_DATE = 2451545.0

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

/**
 * Standard low-precision J2000.0 mean orbital elements for the inner
 * planets (JPL/Meeus "Keplerian elements for approximate positions of the
 * major planets"), converted from the usual (a, e, i, Ω, ϖ, L) table into
 * this module's (Ω, ω, M0) form: ω = ϖ - Ω, M0 = L - ϖ. Valid to a couple
 * of degrees around the present era — plenty for this visualization, and
 * real published numbers rather than an invented approximation.
 */
export const PLANETARY_ELEMENTS: Record<string, OrbitalElements> = {
  mercury: {
    semiMajorAxisAu: 0.38709927,
    eccentricity: 0.20563593,
    inclinationDeg: 7.00497902,
    ascendingNodeDeg: 48.33076593,
    perihelionArgumentDeg: 29.12703035,
    meanAnomalyDeg: 174.79252722,
    meanMotionDegPerDay: 4.09233445,
    epochJulianDate: J2000_JULIAN_DATE,
  },
  venus: {
    semiMajorAxisAu: 0.72333566,
    eccentricity: 0.00677672,
    inclinationDeg: 3.39467605,
    ascendingNodeDeg: 76.67984255,
    perihelionArgumentDeg: 54.92262463,
    meanAnomalyDeg: 50.37663232,
    meanMotionDegPerDay: 1.60213022,
    epochJulianDate: J2000_JULIAN_DATE,
  },
  earth: {
    semiMajorAxisAu: 1.00000261,
    eccentricity: 0.01671123,
    inclinationDeg: -0.00001531,
    ascendingNodeDeg: 0,
    perihelionArgumentDeg: 102.93768193,
    meanAnomalyDeg: 357.52688973,
    meanMotionDegPerDay: 0.98560912,
    epochJulianDate: J2000_JULIAN_DATE,
  },
  mars: {
    semiMajorAxisAu: 1.52371034,
    eccentricity: 0.09339410,
    inclinationDeg: 1.84969142,
    ascendingNodeDeg: 49.55953891,
    perihelionArgumentDeg: 286.4968315,
    meanAnomalyDeg: 19.39019754,
    meanMotionDegPerDay: 0.52402068,
    epochJulianDate: J2000_JULIAN_DATE,
  },
}

export function earthHeliocentricPosition(julianDate: number): Vec3 {
  return heliocentricPosition(PLANETARY_ELEMENTS.earth, julianDate)
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

/** Samples a full ellipse for drawing a static orbit-path line. */
export function orbitPathPoints(elements: OrbitalElements, segments = 128): Vec3[] {
  const points: Vec3[] = []
  for (let i = 0; i <= segments; i += 1) {
    const meanAnomalyDeg = (360 * i) / segments
    points.push(
      heliocentricPosition(
        { ...elements, meanAnomalyDeg, meanMotionDegPerDay: 0, epochJulianDate: 0 },
        0,
      ),
    )
  }
  return points
}
