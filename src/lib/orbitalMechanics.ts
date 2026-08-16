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

/** Newton-Raphson solve of Kepler's equation M = E - e sin(E) for E.
 * Comets can be highly eccentric (Halley: e ~ 0.97) — the naive E0 = M
 * starting guess converges too slowly near e -> 1 for a fixed small
 * iteration count, and a near-zero derivative (1 - e cos E) there can blow
 * up a single step. The standard fix: a better starting guess
 * (E0 = M + e sin M) and more iterations for high-e orbits. */
function solveEccentricAnomaly(meanAnomalyRad: number, eccentricity: number): number {
  let E = meanAnomalyRad + eccentricity * Math.sin(meanAnomalyRad)
  const iterations = eccentricity > 0.8 ? 30 : 10
  for (let i = 0; i < iterations; i += 1) {
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
export type PlanetKey =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'

/** Record<PlanetKey, ...> (not Record<string, ...>) deliberately: a missing
 * entry here previously produced silent NaN positions (spreading `undefined`
 * elements into an object literal is a no-op in JS, not a throw) instead of
 * a compile error. This type makes a missing planet a build failure. */
export const PLANETARY_ELEMENTS: Record<PlanetKey, OrbitalElements> = {
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
  jupiter: {
    semiMajorAxisAu: 5.20288700,
    eccentricity: 0.04838624,
    inclinationDeg: 1.30439695,
    ascendingNodeDeg: 100.47390909,
    perihelionArgumentDeg: 274.25457074,
    meanAnomalyDeg: 19.66796068,
    meanMotionDegPerDay: 0.08308910,
    epochJulianDate: J2000_JULIAN_DATE,
  },
  saturn: {
    semiMajorAxisAu: 9.53667594,
    eccentricity: 0.05386179,
    inclinationDeg: 2.48599187,
    ascendingNodeDeg: 113.66242448,
    perihelionArgumentDeg: 338.93645383,
    meanAnomalyDeg: 317.35536592,
    meanMotionDegPerDay: 0.03346821,
    epochJulianDate: J2000_JULIAN_DATE,
  },
  uranus: {
    semiMajorAxisAu: 19.18916464,
    eccentricity: 0.04725744,
    inclinationDeg: 0.77263783,
    ascendingNodeDeg: 74.01692503,
    perihelionArgumentDeg: 96.93735127,
    meanAnomalyDeg: 142.28382821,
    meanMotionDegPerDay: 0.01173245,
    epochJulianDate: J2000_JULIAN_DATE,
  },
  neptune: {
    semiMajorAxisAu: 30.06992276,
    eccentricity: 0.00859048,
    inclinationDeg: 1.77004347,
    ascendingNodeDeg: 131.78422574,
    perihelionArgumentDeg: 273.18053653,
    meanAnomalyDeg: 259.91520804,
    meanMotionDegPerDay: 0.00598160,
    epochJulianDate: J2000_JULIAN_DATE,
  },
}

export function earthHeliocentricPosition(julianDate: number): Vec3 {
  return heliocentricPosition(PLANETARY_ELEMENTS.earth, julianDate)
}

// Moon — Paul Schlyter's well-known low-precision geocentric formula
// (stjarnhimlen.se/comp/tutorial.html). Unlike the planets, the Moon's
// ascending node and argument of perigee aren't fixed — they precess
// measurably (node regresses ~18.6yr period, perigee advances ~8.85yr) —
// so both are linear-in-time here rather than constants, evaluated at the
// target date and fed into heliocentricPosition with meanMotionDegPerDay
// zeroed out (the drift is already baked into the evaluated values).
export const MOON_SEMI_MAJOR_AXIS_EARTH_RADII = 60.2666
const MOON_ECCENTRICITY = 0.0549
const MOON_INCLINATION_DEG = 5.1454
const MOON_NODE_AT_J2000_DEG = 125.1228
const MOON_NODE_DRIFT_DEG_PER_DAY = -0.0529538083
const MOON_PERIGEE_AT_J2000_DEG = 318.0634
const MOON_PERIGEE_DRIFT_DEG_PER_DAY = 0.1643573223
const MOON_MEAN_ANOMALY_AT_J2000_DEG = 115.3654
const MOON_MEAN_MOTION_DEG_PER_DAY = 13.0649929509

/** Geocentric Moon position in Earth radii (not AU — this orbits Earth, not
 * the Sun) using the classical-elements machinery above with precessing
 * node/perigee evaluated at this date. */
export function moonGeocentricPositionEarthRadii(julianDate: number): Vec3 {
  const d = julianDate - J2000_JULIAN_DATE
  const elements: OrbitalElements = {
    semiMajorAxisAu: MOON_SEMI_MAJOR_AXIS_EARTH_RADII,
    eccentricity: MOON_ECCENTRICITY,
    inclinationDeg: MOON_INCLINATION_DEG,
    ascendingNodeDeg: MOON_NODE_AT_J2000_DEG + MOON_NODE_DRIFT_DEG_PER_DAY * d,
    perihelionArgumentDeg: MOON_PERIGEE_AT_J2000_DEG + MOON_PERIGEE_DRIFT_DEG_PER_DAY * d,
    meanAnomalyDeg: MOON_MEAN_ANOMALY_AT_J2000_DEG + MOON_MEAN_MOTION_DEG_PER_DAY * d,
    meanMotionDegPerDay: 0,
    epochJulianDate: julianDate,
  }
  return heliocentricPosition(elements, julianDate)
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export type CometKey = 'halley' | 'encke' | 'churyumovGerasimenko'

/** Real elements from NASA/JPL's Small-Body Database (ssd-api.jpl.nasa.gov),
 * same heliocentric-elements shape as the planets. Halley (i ~ 162°) is a
 * real retrograde orbit — it falls out of the same rotation math with no
 * special-casing, inclination just isn't clamped to <90°. */
export const COMET_ELEMENTS: Record<CometKey, OrbitalElements> = {
  halley: {
    semiMajorAxisAu: 17.92863504856923,
    eccentricity: 0.9679359956953211,
    inclinationDeg: 162.1905300439129,
    ascendingNodeDeg: 59.09894720612437,
    perihelionArgumentDeg: 112.2414314637764,
    meanAnomalyDeg: 274.3823371366792,
    meanMotionDegPerDay: 0.01298324443268444,
    epochJulianDate: 2439875.5,
  },
  encke: {
    semiMajorAxisAu: 2.219688807038326,
    eccentricity: 0.8477003352638754,
    inclinationDeg: 11.40704098723543,
    ascendingNodeDeg: 334.1851099834068,
    perihelionArgumentDeg: 187.1421582207019,
    meanAnomalyDeg: 245.5009109690059,
    meanMotionDegPerDay: 0.2980340851957727,
    epochJulianDate: 2459855.5,
  },
  churyumovGerasimenko: {
    semiMajorAxisAu: 3.462249489765068,
    eccentricity: 0.6409081306555051,
    inclinationDeg: 7.040294906760007,
    ascendingNodeDeg: 50.13557380441372,
    perihelionArgumentDeg: 12.79824973415729,
    meanAnomalyDeg: 8.859927418758764,
    meanMotionDegPerDay: 0.1529912292115438,
    epochJulianDate: 2457305.5,
  },
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
