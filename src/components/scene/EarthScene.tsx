'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Line, OrbitControls, Stars, useTexture } from '@react-three/drei'
import {
  AdditiveBlending,
  BackSide,
  type DirectionalLight,
  type Group,
  type Mesh,
  type ShaderMaterial,
} from 'three'
import type { NearEarthObject } from '@/lib/nasa'
import {
  PLANETARY_ELEMENTS,
  earthHeliocentricPosition,
  heliocentricPosition,
  orbitPathPoints,
  subtract,
  unixMsToJulianDate,
  type OrbitalElements,
} from '@/lib/orbitalMechanics'
import { latLonAltToPosition, type IssPosition } from '@/lib/spaceObjects'

// Status colors from the dataviz skill's fixed status palette — reserved for
// the asteroid hazard flag only, never reused for arbitrary series identity.
const STATUS_HAZARDOUS = '#d03b3b' // critical
const STATUS_SAFE = '#0ca30c' // good

// Categorical object-type colors — first 3 slots of the dataviz skill's
// default palette, the only ones that pass the all-pairs CVD check (any two
// markers can sit side by side here, so the adjacent-only check isn't enough).
// Validated: node validate_palette.js "#3987e5,#d95926,#199e70" --mode dark
// --surface "#000000" --pairs all -> ALL CHECKS PASS.
const TYPE_SATELLITE = '#3987e5' // blue
const TYPE_SHUTTLE = '#d95926' // orange
const TYPE_STATION = '#199e70' // aqua

const AU_IN_KM = 149_597_870.7

// Real-time anchor for the orbital simulation clock: Julian Date at module
// load, advanced by simulated days per real second so orbital motion (whose
// real periods are months to years) is visible within a viewing session
// instead of imperceptibly slow. See orbitalMechanics.ts.
const BASE_JULIAN_DATE = unixMsToJulianDate(Date.now())
const SIMULATED_DAYS_PER_SECOND = 8
const AU_SCALE = 4 // scene units per astronomical unit

function simulatedJulianDate(elapsedSeconds: number): number {
  return BASE_JULIAN_DATE + elapsedSeconds * SIMULATED_DAYS_PER_SECOND
}

/** Earth-relative direction toward the Sun right now (live, simulated time) —
 * the Sun sits at the heliocentric origin, so this is just -earthPosition. */
function liveSunDirection(elapsedSeconds: number): [number, number, number] {
  const earthPos = earthHeliocentricPosition(simulatedJulianDate(elapsedSeconds))
  const length = Math.hypot(earthPos.x, earthPos.y, earthPos.z) || 1
  return [-earthPos.x / length, -earthPos.y / length, -earthPos.z / length]
}

// ---------------------------------------------------------------------------
// Selection / info panel
// ---------------------------------------------------------------------------

type InfoRow = { label: string; value: string }
type SelectedInfo = { title: string; subtitle: string; rows: InfoRow[] }

const SelectionContext = createContext<(info: SelectedInfo | null) => void>(() => {})

function useSelect() {
  return useContext(SelectionContext)
}

function InfoPanel({ info, onClose }: { info: SelectedInfo; onClose: () => void }) {
  return (
    <div className="pointer-events-auto absolute right-4 top-16 w-64 rounded border border-white/15 bg-black/75 p-3 font-mono text-xs text-white/85 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2 border-b border-white/15 pb-2">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.1em] text-white">{info.title}</p>
          <p className="text-white/50">{info.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close object details"
          className="min-h-6 min-w-6 border border-white/20 px-1.5 text-white/70 hover:bg-white/10"
        >
          ×
        </button>
      </div>
      <dl className="mt-2 space-y-1">
        {info.rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3">
            <dt className="text-white/50">{row.label}</dt>
            <dd className="tabular-nums text-white">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Earth
// ---------------------------------------------------------------------------

const EARTH_DAY_NIGHT_VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const EARTH_DAY_NIGHT_FRAGMENT_SHADER = `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    float sunFacing = dot(normalize(vNormal), normalize(sunDirection));
    // Smooth terminator band rather than a hard day/night line.
    float dayMix = smoothstep(-0.15, 0.15, sunFacing);
    vec3 dayColor = texture2D(dayMap, vUv).rgb;
    vec3 nightColor = texture2D(nightMap, vUv).rgb * 1.6; // city lights read as a glow, not a dim photo
    gl_FragColor = vec4(mix(nightColor, dayColor, dayMix), 1.0);
  }
`

function Clouds() {
  const meshRef = useRef<Mesh>(null)
  const cloudsMap = useTexture('/textures/2k_earth_clouds.jpg')

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.065
    }
  })

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1.008, 64, 64]} />
      {/* Cloud map is white-on-black with no alpha channel; additive blending
          makes the black background contribute nothing while clouds glow. */}
      <meshBasicMaterial map={cloudsMap} blending={AdditiveBlending} transparent opacity={0.35} />
    </mesh>
  )
}

function Atmosphere() {
  return (
    <mesh scale={1.06}>
      <sphereGeometry args={[1, 64, 64]} />
      <shaderMaterial
        vertexShader={`
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          varying vec3 vNormal;
          void main() {
            float rim = pow(0.7 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
            gl_FragColor = vec4(0.35, 0.55, 1.0, clamp(rim, 0.0, 1.0));
          }
        `}
        transparent
        blending={AdditiveBlending}
        side={BackSide}
      />
    </mesh>
  )
}

function Earth() {
  const meshRef = useRef<Mesh>(null)
  const materialRef = useRef<ShaderMaterial>(null)
  const select = useSelect()
  // Real daily satellite mosaic (NASA GIBS) instead of a static generic map.
  const [dayMap, nightMap] = useTexture(['/api/earth-imagery', '/textures/2k_earth_nightmap.jpg'])

  const uniforms = useMemo(
    () => ({
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      sunDirection: { value: liveSunDirection(0) },
    }),
    [dayMap, nightMap],
  )

  useFrame((state, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.05
    }
    // Live terminator: the day/night line tracks the Sun's real simulated
    // position instead of a direction fixed at mount.
    if (materialRef.current) {
      const [x, y, z] = liveSunDirection(state.clock.elapsedTime)
      const dir = materialRef.current.uniforms.sunDirection.value as {
        x: number
        y: number
        z: number
      }
      dir.x = x
      dir.y = y
      dir.z = z
    }
  })

  return (
    <group>
      <mesh
        ref={meshRef}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation()
          select({
            title: 'Earth',
            subtitle: 'Home planet — scene reference point',
            rows: [
              { label: 'Mean radius', value: '6,371 km' },
              { label: 'Orbital period', value: '365.25 days' },
              { label: 'Rotation period', value: '23h 56m' },
            ],
          })
        }}
      >
        <sphereGeometry args={[1, 64, 64]} />
        <shaderMaterial
          ref={materialRef}
          uniforms={uniforms}
          vertexShader={EARTH_DAY_NIGHT_VERTEX_SHADER}
          fragmentShader={EARTH_DAY_NIGHT_FRAGMENT_SHADER}
        />
      </mesh>
      <Clouds />
      <Atmosphere />
    </group>
  )
}

// ---------------------------------------------------------------------------
// Sun + light — the only light source in the scene
// ---------------------------------------------------------------------------

/** Tracks the same live direction as the Earth shader's terminator, so the
 * two can never drift apart the way a fixed light direction would. This is
 * the ONLY light in the scene — no ambient fill — so unlit sides of
 * planets/moons go genuinely dark, the way sunlight actually works. */
function SunLight() {
  const lightRef = useRef<DirectionalLight>(null)

  useFrame((state) => {
    if (!lightRef.current) return
    const [x, y, z] = liveSunDirection(state.clock.elapsedTime)
    lightRef.current.position.set(x * 5, y * 5, z * 5)
  })

  return <directionalLight ref={lightRef} intensity={2.2} />
}

const SUN_GLOW_VERTEX_SHADER = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const SUN_GLOW_FRAGMENT_SHADER = `
  varying vec3 vNormal;
  void main() {
    float rim = pow(0.75 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.5);
    gl_FragColor = vec4(1.0, 0.75, 0.35, clamp(rim, 0.0, 1.0));
  }
`

/** The Sun: real texture, self-lit (meshBasicMaterial ignores scene
 * lighting, which is correct — the Sun is the light source, not something
 * lit by it). Lives inside <HeliocentricFrame>, so its local position is
 * always the heliocentric origin; only self-rotation is animated here. Size
 * is artistic (a real-scale Sun at AU_SCALE would be ~109x Earth's radius
 * and swallow the scene). */
function Sun() {
  const spinRef = useRef<Mesh>(null)
  const select = useSelect()
  const surfaceMap = useTexture('/textures/2k_sun.jpg')

  useFrame((_, delta) => {
    if (spinRef.current) spinRef.current.rotation.y += delta * 0.03
  })

  return (
    <group
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select({
          title: 'Sun',
          subtitle: 'G-type main-sequence star',
          rows: [
            { label: 'Mean radius', value: '696,000 km' },
            { label: 'Surface temp.', value: '~5,500 °C' },
            { label: 'Distance from Earth', value: '1 AU (149.6M km)' },
          ],
        })
      }}
    >
      <mesh ref={spinRef}>
        <sphereGeometry args={[0.65, 48, 48]} />
        <meshBasicMaterial map={surfaceMap} />
      </mesh>
      <mesh scale={1.25}>
        <sphereGeometry args={[0.65, 32, 32]} />
        <shaderMaterial
          vertexShader={SUN_GLOW_VERTEX_SHADER}
          fragmentShader={SUN_GLOW_FRAGMENT_SHADER}
          transparent
          blending={AdditiveBlending}
          side={BackSide}
        />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Heliocentric frame — Sun, planets, orbit rings, and real-orbit asteroids
// all live here with plain heliocentric coordinates. The whole frame is
// translated by -Earth's live position once per frame, which is
// equivalent to subtracting Earth's position from every child individually
// but far cheaper: one transform instead of N.
// ---------------------------------------------------------------------------

function HeliocentricFrame({ children }: { children: React.ReactNode }) {
  const groupRef = useRef<Group>(null)

  useFrame((state) => {
    if (!groupRef.current) return
    const jd = simulatedJulianDate(state.clock.elapsedTime)
    const earthPos = earthHeliocentricPosition(jd)
    groupRef.current.position.set(-earthPos.x * AU_SCALE, -earthPos.y * AU_SCALE, -earthPos.z * AU_SCALE)
  })

  return <group ref={groupRef}>{children}</group>
}

type PlanetConfig = {
  key: string
  label: string
  texture: string
  radius: number
  rotationPeriodDays: number
}

const PLANETS: PlanetConfig[] = [
  { key: 'mercury', label: 'Mercury', texture: '/textures/2k_mercury.jpg', radius: 0.06, rotationPeriodDays: 58.646 },
  { key: 'venus', label: 'Venus', texture: '/textures/2k_venus_atmosphere.jpg', radius: 0.09, rotationPeriodDays: -243.025 },
  { key: 'mars', label: 'Mars', texture: '/textures/2k_mars.jpg', radius: 0.055, rotationPeriodDays: 1.02596 },
]

/** A real neighboring planet, positioned at its own live heliocentric
 * coordinates (the parent <HeliocentricFrame> already accounts for Earth's
 * offset). Rotation period is real too (Venus rotates backward: retrograde
 * -243 days), scaled by the same simulated-time acceleration as everything
 * else in the scene. */
function Planet({ config }: { config: PlanetConfig }) {
  const groupRef = useRef<Group>(null)
  const spinRef = useRef<Mesh>(null)
  const map = useTexture(config.texture)
  const elements = PLANETARY_ELEMENTS[config.key]
  const select = useSelect()
  const { clock } = useThree()

  useFrame((state) => {
    if (!groupRef.current) return
    const jd = simulatedJulianDate(state.clock.elapsedTime)
    const planetPos = heliocentricPosition(elements, jd)
    groupRef.current.position.set(planetPos.x * AU_SCALE, planetPos.y * AU_SCALE, planetPos.z * AU_SCALE)
    if (spinRef.current) {
      const simulatedDaysElapsed = jd - BASE_JULIAN_DATE
      spinRef.current.rotation.y = (simulatedDaysElapsed / config.rotationPeriodDays) * Math.PI * 2
    }
  })

  const periodDays = 360 / elements.meanMotionDegPerDay

  return (
    <group
      ref={groupRef}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        const jd = simulatedJulianDate(clock.getElapsedTime())
        const relative = subtract(heliocentricPosition(elements, jd), earthHeliocentricPosition(jd))
        const distanceAu = Math.hypot(relative.x, relative.y, relative.z)
        select({
          title: config.label,
          subtitle: 'Planet',
          rows: [
            { label: 'Orbital period', value: `${periodDays.toFixed(1)} days` },
            { label: 'Semi-major axis', value: `${elements.semiMajorAxisAu.toFixed(3)} AU` },
            {
              label: 'Rotation period',
              value: `${Math.abs(config.rotationPeriodDays).toFixed(1)} days${config.rotationPeriodDays < 0 ? ' (retrograde)' : ''}`,
            },
            {
              label: 'Distance from Earth',
              value: `${distanceAu.toFixed(3)} AU / ${(distanceAu * AU_IN_KM / 1_000_000).toFixed(1)}M km`,
            },
          ],
        })
      }}
    >
      <mesh ref={spinRef}>
        <sphereGeometry args={[config.radius, 24, 24]} />
        <meshStandardMaterial map={map} roughness={0.9} />
      </mesh>
    </group>
  )
}

/** Static ellipse traced from the planet's real orbital elements — since the
 * elements themselves don't change, this needs no per-frame recompute; the
 * parent <HeliocentricFrame>'s single transform keeps it Earth-relative. */
function OrbitRing({ elements, color }: { elements: OrbitalElements; color: string }) {
  const points = useMemo(
    () => orbitPathPoints(elements, 128).map((p) => [p.x * AU_SCALE, p.y * AU_SCALE, p.z * AU_SCALE] as const),
    [elements],
  )
  return <Line points={points} color={color} transparent opacity={0.25} lineWidth={1} />
}

function InnerSolarSystem() {
  return (
    <>
      <OrbitRing elements={PLANETARY_ELEMENTS.earth} color="#3987e5" />
      {PLANETS.map((config) => (
        <OrbitRing key={`ring-${config.key}`} elements={PLANETARY_ELEMENTS[config.key]} color="#5a5a52" />
      ))}
      {PLANETS.map((config) => (
        <Planet key={config.key} config={config} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Near-Earth objects
// ---------------------------------------------------------------------------

function hashId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return hash
}

type FallbackOrbit = { radius: number; phi: number; theta0: number; angularSpeed: number }

/** Only used when NASA's per-object orbital-elements lookup failed for this
 * asteroid — same real-data-informed circular approximation as before
 * (radius from actual miss distance, speed from actual relative velocity),
 * so a lookup failure degrades gracefully instead of hiding the object. */
function fallbackOrbit(neo: NearEarthObject, index: number): FallbackOrbit {
  const hash = hashId(neo.id)
  const theta0 = ((hash % 360) / 360) * Math.PI * 2
  const phi = (((hash >> 8) % 180) / 180) * Math.PI - Math.PI / 2
  const radius = Math.min(6, 1.8 + Math.log10(Math.max(neo.missDistanceKm, 1e5)) * 0.35 + index * 0.01)
  const angularSpeed = Math.min(0.18, 0.02 + neo.relativeVelocityKmS * 0.004)
  return { radius, phi, theta0, angularSpeed }
}

function neoInfo(neo: NearEarthObject): SelectedInfo {
  const rows: InfoRow[] = [
    { label: 'Diameter (est.)', value: `${(neo.estimatedDiameterKm * 1000).toFixed(0)} m` },
    { label: 'Hazardous', value: neo.isPotentiallyHazardous ? 'Yes' : 'No' },
    { label: 'Close approach', value: neo.closeApproachDate },
    { label: 'Miss distance', value: `${(neo.missDistanceKm / 1000).toFixed(0)}k km` },
    { label: 'Relative speed', value: `${neo.relativeVelocityKmS.toFixed(1)} km/s` },
  ]
  if (neo.orbit) {
    rows.push(
      { label: 'Semi-major axis', value: `${neo.orbit.semiMajorAxisAu.toFixed(3)} AU` },
      { label: 'Orbital period', value: `${(360 / neo.orbit.meanMotionDegPerDay).toFixed(0)} days` },
    )
  }
  return {
    title: neo.name,
    subtitle: neo.orbit ? 'Near-Earth asteroid — real orbit' : 'Near-Earth asteroid — approximated',
    rows,
  }
}

function HelioNeoMarker({ neo }: { neo: NearEarthObject }) {
  const meshRef = useRef<Mesh>(null)
  const select = useSelect()
  const radius = Math.min(0.12, Math.max(0.02, neo.estimatedDiameterKm * 0.05))
  const color = neo.isPotentiallyHazardous ? STATUS_HAZARDOUS : STATUS_SAFE
  const orbit = neo.orbit as OrbitalElements

  useFrame((state) => {
    if (!meshRef.current) return
    const jd = simulatedJulianDate(state.clock.elapsedTime)
    const pos = heliocentricPosition(orbit, jd)
    meshRef.current.position.set(pos.x * AU_SCALE, pos.y * AU_SCALE, pos.z * AU_SCALE)
  })

  return (
    <mesh
      ref={meshRef}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(neoInfo(neo))
      }}
    >
      <sphereGeometry args={[radius, 12, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
    </mesh>
  )
}

/** Earth-relative schematic placement — deliberately NOT inside
 * <HeliocentricFrame>, since without real elements there's no heliocentric
 * position to put there. */
function FallbackNeoMarker({ neo, index }: { neo: NearEarthObject; index: number }) {
  const meshRef = useRef<Mesh>(null)
  const select = useSelect()
  const radius = Math.min(0.12, Math.max(0.02, neo.estimatedDiameterKm * 0.05))
  const color = neo.isPotentiallyHazardous ? STATUS_HAZARDOUS : STATUS_SAFE
  const orbit = useMemo(() => fallbackOrbit(neo, index), [neo, index])

  useFrame((state) => {
    if (!meshRef.current) return
    const theta = orbit.theta0 + state.clock.elapsedTime * orbit.angularSpeed
    meshRef.current.position.set(
      orbit.radius * Math.cos(orbit.phi) * Math.cos(theta),
      orbit.radius * Math.sin(orbit.phi),
      orbit.radius * Math.cos(orbit.phi) * Math.sin(theta),
    )
  })

  return (
    <mesh
      ref={meshRef}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(neoInfo(neo))
      }}
    >
      <sphereGeometry args={[radius, 12, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
    </mesh>
  )
}

function HelioNeoField({ objects }: { objects: NearEarthObject[] }) {
  return (
    <>
      {objects.map((neo) => (
        <HelioNeoMarker key={neo.id} neo={neo} />
      ))}
    </>
  )
}

function FallbackNeoField({ objects }: { objects: NearEarthObject[] }) {
  return (
    <>
      {objects.map((neo, index) => (
        <FallbackNeoMarker key={neo.id} neo={neo} index={index} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Space station (ISS) — Earth-relative, not heliocentric
// ---------------------------------------------------------------------------

/** Torus silhouette reads as a station's ring/truss structure at marker scale. */
function StationMarker({
  position,
  fix,
}: {
  position: [number, number, number]
  fix: IssPosition
}) {
  const ref = useRef<Mesh>(null)
  const select = useSelect()
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.z += delta * 0.3
  })

  return (
    <mesh
      ref={ref}
      position={position}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select({
          title: 'ISS',
          subtitle: 'International Space Station — live',
          rows: [
            { label: 'Altitude', value: `${fix.altitudeKm.toFixed(0)} km` },
            { label: 'Velocity', value: `${fix.velocityKmH.toFixed(0)} km/h` },
            { label: 'Latitude', value: fix.latitude.toFixed(2) },
            { label: 'Longitude', value: fix.longitude.toFixed(2) },
          ],
        })
      }}
    >
      <torusGeometry args={[0.05, 0.012, 8, 16]} />
      <meshStandardMaterial color={TYPE_STATION} emissive={TYPE_STATION} emissiveIntensity={0.5} />
    </mesh>
  )
}

function IssTracker({ onFix }: { onFix: () => void }) {
  const [fix, setFix] = useState<IssPosition | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      fetch('/api/iss')
        .then((res) => res.json())
        .then((data: IssPosition & { error?: string }) => {
          if (!cancelled && !data.error) {
            setFix(data)
            onFix()
          }
        })
        .catch(() => {})
    }
    poll()
    const interval = setInterval(poll, 15000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [onFix])

  if (!fix) return null
  const position = latLonAltToPosition(fix.latitude, fix.longitude, fix.altitudeKm)
  return <StationMarker position={position} fix={fix} />
}

// ---------------------------------------------------------------------------
// Legend + scene root
// ---------------------------------------------------------------------------

function TypeLegend({
  neoCount,
  trackedCount,
  issTracked,
}: {
  neoCount: number
  trackedCount: number
  issTracked: boolean
}) {
  const rows: Array<{ color: string; shape: string; label: string }> = [
    { color: STATUS_HAZARDOUS, shape: 'rounded-full', label: 'asteroid — potentially hazardous' },
    { color: STATUS_SAFE, shape: 'rounded-full', label: 'asteroid — not hazardous' },
    {
      color: TYPE_STATION,
      shape: 'rounded-full',
      label: issTracked ? 'space station — ISS (live)' : 'space station — awaiting fix',
    },
    { color: TYPE_SATELLITE, shape: 'rounded-full', label: 'satellite — tracking pending' },
    { color: TYPE_SHUTTLE, shape: 'rounded-full', label: 'shuttle — tracking pending' },
  ]

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1 rounded border border-white/15 bg-black/60 px-3 py-2 font-mono text-xs text-white/80 backdrop-blur-sm">
      <p className="text-white/50">
        {neoCount} near-Earth objects · {trackedCount} on real heliocentric orbits
      </p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 ${row.shape}`} style={{ background: row.color }} />
          {row.label}
        </p>
      ))}
      <p className="text-white/40">Tap an object for details</p>
    </div>
  )
}

export function EarthScene() {
  const [objects, setObjects] = useState<NearEarthObject[]>([])
  const [issTracked, setIssTracked] = useState(false)
  const [selected, setSelected] = useState<SelectedInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/neos')
      .then((res) => res.json())
      .then((data: { objects?: NearEarthObject[] }) => {
        if (!cancelled) setObjects(data.objects ?? [])
      })
      .catch(() => {
        if (!cancelled) setObjects([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const select = useCallback((info: SelectedInfo | null) => setSelected(info), [])

  const trackedObjects = objects.filter((neo) => neo.orbit !== null)
  const fallbackObjects = objects.filter((neo) => neo.orbit === null)

  return (
    <SelectionContext.Provider value={select}>
      <div className="relative h-full w-full">
        <Canvas
          camera={{ position: [0, 0, 3], fov: 45 }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          dpr={[1, 2]}
          onPointerMissed={() => setSelected(null)}
        >
          {/* SunLight is the only light in the scene — no ambient fill — so
              unlit sides genuinely go dark, the way real sunlight works. */}
          <SunLight />
          <Earth />
          <HeliocentricFrame>
            <Sun />
            <InnerSolarSystem />
            <HelioNeoField objects={trackedObjects} />
          </HeliocentricFrame>
          <FallbackNeoField objects={fallbackObjects} />
          <IssTracker onFix={() => setIssTracked(true)} />
          <Stars radius={80} depth={40} count={3000} factor={3} fade />
          <OrbitControls enablePan={false} minDistance={1.5} maxDistance={20} />
        </Canvas>
        <TypeLegend neoCount={objects.length} trackedCount={trackedObjects.length} issTracked={issTracked} />
        {selected ? <InfoPanel info={selected} onClose={() => setSelected(null)} /> : null}
      </div>
    </SelectionContext.Provider>
  )
}
