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
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { Line, OrbitControls, Stars, useTexture } from '@react-three/drei'
import {
  AdditiveBlending,
  BackSide,
  Vector3,
  type DirectionalLight,
  type Group,
  type Mesh,
  type Object3D,
  type ShaderMaterial,
} from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { NearEarthObject } from '@/lib/nasa'
import {
  COMET_ELEMENTS,
  PLANETARY_ELEMENTS,
  earthHeliocentricPosition,
  heliocentricPosition,
  MOON_SEMI_MAJOR_AXIS_EARTH_RADII,
  moonGeocentricPositionEarthRadii,
  moonOrbitalElements,
  orbitPathPoints,
  subtract,
  unixMsToJulianDate,
  type CometKey,
  type OrbitalElements,
  type PlanetKey,
} from '@/lib/orbitalMechanics'
import { latLonAltToPosition, type IssPosition } from '@/lib/spaceObjects'
import { SatelliteConstellation } from './SatelliteConstellation'

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
const EARTH_RADIUS = 0.5 // scene units — was an oversized 1

// The Moon's real distance is ~60 Earth radii — at true scale (60 * 0.5 =
// 30 scene units) it would land out past Jupiter's orbit, invisible next to
// Earth. Compressed to a fixed scene-unit distance instead, same "subway
// map" trade-off as the outer-planet compression above.
const MOON_SCENE_ORBIT_RADIUS = 1.8
const MOON_ORBIT_SCALE = MOON_SCENE_ORBIT_RADIUS / MOON_SEMI_MAJOR_AXIS_EARTH_RADII

// Distinct from the planet-ring grey (#5a5a52) and the Earth-ring blue
// (#3987e5) — every moon orbit (Earth's own and other planets') shares this
// one muted color, fainter than a planet ring, so the ring hierarchy reads
// at a glance: planets brightest, moons faintest.
const MOON_RING_COLOR = '#7d89a3'
const AU_SCALE = 6 // scene units per AU inside the inner system — was 4, more breathing room

// Beyond Mars' neighborhood, real AU distances get compressed (log scale) so
// Neptune doesn't require an absurd camera distance to include. This is a
// deliberate "subway map" distortion for the outer solar system, not a claim
// of literal scale — inner planets stay at true relative distance.
const OUTER_COMPRESSION_START_AU = 2.2
const OUTER_COMPRESSION_FACTOR = 2.5

function sceneDistanceForAu(auDistance: number): number {
  if (auDistance <= OUTER_COMPRESSION_START_AU) return auDistance * AU_SCALE
  const linear = OUTER_COMPRESSION_START_AU * AU_SCALE
  const compressed = Math.log10(1 + (auDistance - OUTER_COMPRESSION_START_AU)) * OUTER_COMPRESSION_FACTOR * AU_SCALE
  return linear + compressed
}

/** Scales a heliocentric AU-space vector into scene units, preserving
 * direction and applying the outer-system distance compression. */
function toScenePosition(vec: { x: number; y: number; z: number }): [number, number, number] {
  const distance = Math.hypot(vec.x, vec.y, vec.z) || 1e-9
  const scale = sceneDistanceForAu(distance) / distance
  return [vec.x * scale, vec.y * scale, vec.z * scale]
}

// ---------------------------------------------------------------------------
// Simulation clock — one authoritative accumulator (real elapsed seconds
// integrated by a live-adjustable speed), read by every other component.
// Runs at R3F priority -1 so it always updates before anything reading it
// in the same frame.
// ---------------------------------------------------------------------------

const REALTIME_DAYS_PER_SECOND = 1 / 86400
const ACCELERATED_DAYS_PER_SECOND = 8
const FAST_DAYS_PER_SECOND = 45

const BASE_JULIAN_DATE = unixMsToJulianDate(Date.now())

type SpeedRef = { current: number }
type ClockRef = { current: number }

const SpeedContext = createContext<SpeedRef>({ current: ACCELERATED_DAYS_PER_SECOND })
const ClockContext = createContext<ClockRef>({ current: BASE_JULIAN_DATE })

function useSimulationClock(): ClockRef {
  return useContext(ClockContext)
}

function SimulationClockProvider({
  speedRef,
  children,
}: {
  speedRef: SpeedRef
  children: React.ReactNode
}) {
  // A real ref: mutated every frame in useFrame (never read during render —
  // consumers read .current themselves, later, inside their own useFrame).
  // The ref *object* is passed through context, not its .current value.
  const clockRef = useRef<number>(BASE_JULIAN_DATE)

  useFrame((_, delta) => {
    clockRef.current += delta * speedRef.current
  }, -1)

  return (
    <SpeedContext.Provider value={speedRef}>
      <ClockContext.Provider value={clockRef}>{children}</ClockContext.Provider>
    </SpeedContext.Provider>
  )
}

/** Earth-relative direction toward the Sun right now — the Sun sits at the
 * heliocentric origin, so this is just -earthPosition. */
function sunDirectionAt(julianDate: number): [number, number, number] {
  const earthPos = earthHeliocentricPosition(julianDate)
  const length = Math.hypot(earthPos.x, earthPos.y, earthPos.z) || 1
  return [-earthPos.x / length, -earthPos.y / length, -earthPos.z / length]
}

// ---------------------------------------------------------------------------
// Selection / camera focus / info panel
// ---------------------------------------------------------------------------

type InfoRow = { label: string; value: string }
type SelectedInfo = { title: string; subtitle: string; rows: InfoRow[] }

const SelectionContext = createContext<(info: SelectedInfo, target?: Object3D | null) => void>(() => {})

function useSelect() {
  return useContext(SelectionContext)
}

function InfoPanel({ info, onClose }: { info: SelectedInfo; onClose: () => void }) {
  return (
    <div className="pointer-events-auto absolute right-4 top-16 w-64 rounded border border-white/25 bg-[#0a0a0d]/90 p-3 font-mono text-xs text-white/85 shadow-[0_2px_16px_rgba(0,0,0,0.6)] backdrop-blur-md">
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

/** Re-centers OrbitControls' orbit point on the selected object's live world
 * position — but only until the user actually touches the controls. A click
 * still eases the camera onto the target; dragging/pinching afterward stops
 * the follow immediately instead of fighting free navigation every frame.
 * Selecting a new target (or the same one again) resumes the follow. */
function CameraFocus({
  target,
  controlsRef,
}: {
  target: Object3D | null
  controlsRef: React.RefObject<OrbitControlsImpl | null>
}) {
  const worldPos = useMemo(() => new Vector3(), [])
  const followingRef = useRef(false)

  useEffect(() => {
    followingRef.current = target !== null
  }, [target])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    const stopFollowing = () => {
      followingRef.current = false
    }
    controls.addEventListener('start', stopFollowing)
    return () => controls.removeEventListener('start', stopFollowing)
  }, [controlsRef])

  useFrame(() => {
    if (!target || !followingRef.current || !controlsRef.current) return
    target.getWorldPosition(worldPos)
    controlsRef.current.target.lerp(worldPos, 0.08)
    controlsRef.current.update()
  })

  return null
}

// ---------------------------------------------------------------------------
// Earth
// ---------------------------------------------------------------------------

const EARTH_DAY_NIGHT_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  void main() {
    // World-space normal — must match sunDirection's own world-space frame.
    // (A view-space normal here was the bug: the terminator would visibly
    // shift whenever the camera orbited, since it was being compared
    // against a world-space sun direction.)
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const EARTH_DAY_NIGHT_FRAGMENT_SHADER = `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform vec3 sunDirection;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  void main() {
    float sunFacing = dot(normalize(vWorldNormal), normalize(sunDirection));
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
      <sphereGeometry args={[EARTH_RADIUS * 1.008, 64, 64]} />
      {/* Cloud map is white-on-black with no alpha channel; additive blending
          makes the black background contribute nothing while clouds glow. */}
      <meshBasicMaterial map={cloudsMap} blending={AdditiveBlending} transparent opacity={0.35} />
    </mesh>
  )
}

function Atmosphere() {
  return (
    <mesh scale={1.06}>
      <sphereGeometry args={[EARTH_RADIUS, 64, 64]} />
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
  const clockRef = useSimulationClock()
  // Real daily satellite mosaic (NASA GIBS) instead of a static generic map.
  const [dayMap, nightMap] = useTexture(['/api/earth-imagery', '/textures/2k_earth_nightmap.jpg'])

  const uniforms = useMemo(
    () => ({
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      sunDirection: { value: sunDirectionAt(BASE_JULIAN_DATE) },
    }),
    [dayMap, nightMap],
  )

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.05
    }
    // Live terminator: the day/night line tracks the Sun's real simulated
    // position instead of a direction fixed at mount.
    if (materialRef.current) {
      const [x, y, z] = sunDirectionAt(clockRef.current)
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
    <group
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(
          {
            title: 'Earth',
            subtitle: 'Home planet — scene reference point',
            rows: [
              { label: 'Mean radius', value: '6,371 km' },
              { label: 'Orbital period', value: '365.25 days' },
              { label: 'Rotation period', value: '23h 56m' },
            ],
          },
          meshRef.current,
        )
      }}
    >
      <mesh ref={meshRef}>
        <sphereGeometry args={[EARTH_RADIUS, 64, 64]} />
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

const MOON_INFO: SelectedInfo = {
  title: 'Moon',
  subtitle: "Earth's only natural satellite",
  rows: [
    { label: 'Mean radius', value: '1,737 km' },
    { label: 'Orbital period', value: '27.32 days (sidereal)' },
    { label: 'Mean distance', value: '384,400 km (60.3 Earth radii)' },
  ],
}

/** Real geocentric orbit — Earth-relative, not heliocentric, so this is a
 * sibling of <Earth/>, not inside <HeliocentricFrame>. At its true relative
 * distance (~60 Earth radii) the Moon is genuinely far from a
 * radius-0.5-scene-unit Earth; rendered radius is boosted for visibility,
 * same "artistic size, real distance" trade-off as the Sun and planets. */
function Moon() {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()
  const map = useTexture('/textures/2k_moon.jpg')

  useFrame(() => {
    if (!groupRef.current) return
    const pos = moonGeocentricPositionEarthRadii(clockRef.current)
    // Uniform scale-down (not a re-normalized circle) — the real orbit's
    // eccentricity still shows, just compressed to a visible distance.
    groupRef.current.position.set(
      pos.x * MOON_ORBIT_SCALE,
      pos.y * MOON_ORBIT_SCALE,
      pos.z * MOON_ORBIT_SCALE,
    )
  })

  return (
    <group
      ref={groupRef}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(MOON_INFO, groupRef.current)
      }}
    >
      <mesh>
        <sphereGeometry args={[0.035, 24, 24]} />
        <meshStandardMaterial map={map} roughness={1} />
      </mesh>
      <ClickTarget
        onClick={(event) => {
          event.stopPropagation()
          select(MOON_INFO, groupRef.current)
        }}
      />
    </group>
  )
}

// ---------------------------------------------------------------------------
// Sun + light — the only light source in the scene
// ---------------------------------------------------------------------------

/** Tracks the same live direction as the Earth shader's terminator, so the
 * two can never drift apart. This is the ONLY light in the scene — no
 * ambient fill — so unlit sides of planets go genuinely dark, the way
 * sunlight actually works. */
function SunLight() {
  const lightRef = useRef<DirectionalLight>(null)
  const clockRef = useSimulationClock()

  useFrame(() => {
    if (!lightRef.current) return
    const [x, y, z] = sunDirectionAt(clockRef.current)
    lightRef.current.position.set(x * 5, y * 5, z * 5)
  })

  return <directionalLight ref={lightRef} intensity={2.4} />
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
 * lighting, which is correct — it IS the light source). Lives inside
 * <HeliocentricFrame>, so its local position is always the heliocentric
 * origin; only self-rotation is animated here. Size is artistic (a
 * real-scale Sun at AU_SCALE would be ~109x Earth's radius). */
const SUN_INFO: SelectedInfo = {
  title: 'Sun',
  subtitle: 'G-type main-sequence star',
  rows: [
    { label: 'Mean radius', value: '696,000 km' },
    { label: 'Surface temp.', value: '~5,500 °C' },
    { label: 'Distance from Earth', value: '1 AU (149.6M km)' },
  ],
}

function Sun() {
  const spinRef = useRef<Mesh>(null)
  const select = useSelect()
  const surfaceMap = useTexture('/textures/2k_sun.jpg')

  useFrame((_, delta) => {
    if (spinRef.current) spinRef.current.rotation.y += delta * 0.03
  })

  // Default camera focus: the Sun selects itself once, on mount, reusing
  // the same click-to-focus system rather than a separate camera path.
  useEffect(() => {
    select(SUN_INFO, spinRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <group
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(SUN_INFO, spinRef.current)
      }}
    >
      <mesh ref={spinRef}>
        <sphereGeometry args={[0.55, 48, 48]} />
        <meshBasicMaterial map={surfaceMap} />
      </mesh>
      <mesh scale={1.25}>
        <sphereGeometry args={[0.55, 32, 32]} />
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
// translated by -Earth's live position once per frame: equivalent to
// subtracting Earth's position from every child individually, but far
// cheaper (one transform instead of N).
// ---------------------------------------------------------------------------

function HeliocentricFrame({ children }: { children: React.ReactNode }) {
  const groupRef = useRef<Group>(null)
  const clockRef = useSimulationClock()

  useFrame(() => {
    if (!groupRef.current) return
    const earthPos = earthHeliocentricPosition(clockRef.current)
    const [x, y, z] = toScenePosition(earthPos)
    groupRef.current.position.set(-x, -y, -z)
  })

  return <group ref={groupRef}>{children}</group>
}

type MoonConfig = {
  key: string
  label: string
  color: string
  renderRadius: number
  sceneOrbitRadius: number
  periodDays: number
  realDistanceKm: number
  realRadiusKm: number
}

type PlanetConfig = {
  key: PlanetKey
  label: string
  texture: string
  radius: number
  rotationPeriodDays: number
  ring?: boolean
  moons?: MoonConfig[]
}

// Real semi-major axis (km) and real sidereal period (days) per moon — the
// orbit itself is simplified to a flat circle at a fixed, artistically
// compressed scene radius (same trade-off as the Moon above), starting from
// an arbitrary phase (no real epoch mean-anomaly data sourced for these).
// All of these are near-circular in reality (e < 0.03) except Titan
// (e ≈ 0.029, still small), so "circular" isn't a big distortion of shape —
// just of absolute distance and starting position.
const MARS_MOONS: MoonConfig[] = [
  { key: 'phobos', label: 'Phobos', color: '#8a7f6e', renderRadius: 0.02, sceneOrbitRadius: 0.34, periodDays: 0.31891, realDistanceKm: 9376, realRadiusKm: 11 },
  { key: 'deimos', label: 'Deimos', color: '#9c9284', renderRadius: 0.018, sceneOrbitRadius: 0.5, periodDays: 1.263, realDistanceKm: 23463, realRadiusKm: 6 },
]

const JUPITER_MOONS: MoonConfig[] = [
  { key: 'io', label: 'Io', color: '#e8d27a', renderRadius: 0.09, sceneOrbitRadius: 2.3, periodDays: 1.769, realDistanceKm: 421_700, realRadiusKm: 1821.6 },
  { key: 'europa', label: 'Europa', color: '#cbb896', renderRadius: 0.08, sceneOrbitRadius: 2.65, periodDays: 3.551, realDistanceKm: 671_034, realRadiusKm: 1560.8 },
  { key: 'ganymede', label: 'Ganymede', color: '#8f8577', renderRadius: 0.1, sceneOrbitRadius: 3.05, periodDays: 7.155, realDistanceKm: 1_070_412, realRadiusKm: 2634.1 },
  { key: 'callisto', label: 'Callisto', color: '#5f584d', renderRadius: 0.095, sceneOrbitRadius: 3.55, periodDays: 16.689, realDistanceKm: 1_882_709, realRadiusKm: 2410.3 },
]

const SATURN_MOONS: MoonConfig[] = [
  { key: 'titan', label: 'Titan', color: '#d9a441', renderRadius: 0.095, sceneOrbitRadius: 4.3, periodDays: 15.945, realDistanceKm: 1_221_870, realRadiusKm: 2574.7 },
]

/** A moon of a non-Earth planet — rendered as a child of that <Planet>'s own
 * group, so it inherits the planet's live heliocentric position for free and
 * only needs to compute its small local offset. No texture (unlike the 8
 * planets and Earth's own Moon) — a plain shaded sphere, same treatment as
 * comets/asteroid markers, to avoid a much larger texture-sourcing pass. */
function PlanetMoon({ config }: { config: MoonConfig }) {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()
  const initialPhaseRad = ((hashId(config.key) % 360) * Math.PI) / 180

  useFrame(() => {
    if (!groupRef.current) return
    const elapsedDays = clockRef.current - BASE_JULIAN_DATE
    const angle = initialPhaseRad + (elapsedDays / config.periodDays) * Math.PI * 2
    groupRef.current.position.set(
      Math.cos(angle) * config.sceneOrbitRadius,
      0,
      Math.sin(angle) * config.sceneOrbitRadius,
    )
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(
      {
        title: config.label,
        subtitle: 'Moon — real distance/period, circular-orbit approximation',
        rows: [
          { label: 'Orbital period', value: `${config.periodDays.toFixed(2)} days` },
          { label: 'Mean distance', value: `${config.realDistanceKm.toLocaleString()} km` },
          { label: 'Mean radius', value: `${config.realRadiusKm.toLocaleString()} km` },
        ],
      },
      groupRef.current,
    )
  }

  return (
    <group ref={groupRef} onClick={handleClick}>
      <mesh>
        <sphereGeometry args={[config.renderRadius, 12, 12]} />
        <meshStandardMaterial color={config.color} roughness={1} />
      </mesh>
      <ClickTarget onClick={handleClick} />
    </group>
  )
}

// Radii follow real Earth-relative size ratios (same "artistic size, real
// distance" trade-off as the Sun/Earth/Moon), tempered down for the gas
// giants so they don't overrun the gap to their neighbors at this AU_SCALE —
// true scale (Jupiter ~11x Earth's radius) would overlap Mars's orbit. Order
// and rough proportion are preserved: Venus is deliberately close to Earth's
// own size (real ratio 0.95), and Mars is bigger than Mercury (real ratio
// 0.53 vs 0.38) — both were previously inverted/flattened here.
const PLANETS: PlanetConfig[] = [
  { key: 'mercury', label: 'Mercury', texture: '/textures/2k_mercury.jpg', radius: 0.16, rotationPeriodDays: 58.646 },
  { key: 'venus', label: 'Venus', texture: '/textures/2k_venus_atmosphere.jpg', radius: 0.47, rotationPeriodDays: -243.025 },
  { key: 'mars', label: 'Mars', texture: '/textures/2k_mars.jpg', radius: 0.24, rotationPeriodDays: 1.02596, moons: MARS_MOONS },
  { key: 'jupiter', label: 'Jupiter', texture: '/textures/2k_jupiter.jpg', radius: 1.9, rotationPeriodDays: 0.41354, moons: JUPITER_MOONS },
  { key: 'saturn', label: 'Saturn', texture: '/textures/2k_saturn.jpg', radius: 1.6, rotationPeriodDays: 0.4375, ring: true, moons: SATURN_MOONS },
  { key: 'uranus', label: 'Uranus', texture: '/textures/2k_uranus.jpg', radius: 0.78, rotationPeriodDays: -0.71833 },
  { key: 'neptune', label: 'Neptune', texture: '/textures/2k_neptune.jpg', radius: 0.75, rotationPeriodDays: 0.6713 },
]

/** A real neighboring planet, positioned at its own live heliocentric
 * coordinates (the parent <HeliocentricFrame> already accounts for Earth's
 * offset; distance compression applies past Mars — see toScenePosition).
 * Rotation period is real too (Venus rotates backward: retrograde -243
 * days), scaled by the same simulated-time acceleration as everything else. */
function Planet({ config }: { config: PlanetConfig }) {
  const groupRef = useRef<Group>(null)
  const spinRef = useRef<Mesh>(null)
  const map = useTexture(config.texture)
  const elements = PLANETARY_ELEMENTS[config.key]
  const select = useSelect()
  const clockRef = useSimulationClock()

  useFrame(() => {
    if (!groupRef.current) return
    const planetPos = heliocentricPosition(elements, clockRef.current)
    const [x, y, z] = toScenePosition(planetPos)
    groupRef.current.position.set(x, y, z)
    if (spinRef.current) {
      const simulatedDaysElapsed = clockRef.current - BASE_JULIAN_DATE
      spinRef.current.rotation.y = (simulatedDaysElapsed / config.rotationPeriodDays) * Math.PI * 2
    }
  })

  const periodDays = 360 / elements.meanMotionDegPerDay

  return (
    <group
      ref={groupRef}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        const relative = subtract(
          heliocentricPosition(elements, clockRef.current),
          earthHeliocentricPosition(clockRef.current),
        )
        const distanceAu = Math.hypot(relative.x, relative.y, relative.z)
        select(
          {
            title: config.label,
            subtitle: 'Planet',
            rows: [
              { label: 'Orbital period', value: `${periodDays.toFixed(1)} days` },
              { label: 'Semi-major axis', value: `${elements.semiMajorAxisAu.toFixed(3)} AU` },
              {
                label: 'Rotation period',
                value: `${Math.abs(config.rotationPeriodDays).toFixed(2)} days${config.rotationPeriodDays < 0 ? ' (retrograde)' : ''}`,
              },
              {
                label: 'Distance from Earth',
                value: `${distanceAu.toFixed(2)} AU / ${((distanceAu * AU_IN_KM) / 1_000_000).toFixed(0)}M km`,
              },
            ],
          },
          spinRef.current,
        )
      }}
    >
      <mesh ref={spinRef}>
        <sphereGeometry args={[config.radius, 24, 24]} />
        <meshStandardMaterial map={map} roughness={0.9} />
      </mesh>
      {config.ring ? (
        <mesh rotation={[Math.PI / 2.3, 0, 0]}>
          <ringGeometry args={[config.radius * 1.4, config.radius * 2.3, 48]} />
          <meshBasicMaterial color="#c9b896" transparent opacity={0.55} side={BackSide} />
        </mesh>
      ) : null}
      {config.moons?.map((moon) => (
        <group key={moon.key}>
          <MoonOrbitCircle radius={moon.sceneOrbitRadius} />
          <PlanetMoon config={moon} />
        </group>
      ))}
    </group>
  )
}

/** Static ellipse traced from the planet's real orbital elements — the
 * elements don't change, so this needs no per-frame recompute; the parent
 * <HeliocentricFrame>'s single transform keeps it Earth-relative. Points go
 * through the same distance compression as the planet markers. */
function OrbitRing({
  elements,
  color,
  opacity = 0.25,
}: {
  elements: OrbitalElements
  color: string
  opacity?: number
}) {
  const points = useMemo(
    () => orbitPathPoints(elements, 160).map((p) => toScenePosition(p)),
    [elements],
  )
  return <Line points={points} color={color} transparent opacity={opacity} lineWidth={1} />
}

/** Earth's Moon ring — a snapshot of the (slowly precessing) geocentric
 * elements at mount, scaled by the same fixed factor as the Moon marker
 * itself. It won't visibly track the real 18.6yr node precession, which is
 * an acceptable simplification: it's imperceptible frame-to-frame even at
 * the fastest simulated time setting. */
function MoonOrbitRing() {
  const points = useMemo(
    () =>
      orbitPathPoints(moonOrbitalElements(BASE_JULIAN_DATE), 128).map(
        (p): [number, number, number] => [p.x * MOON_ORBIT_SCALE, p.y * MOON_ORBIT_SCALE, p.z * MOON_ORBIT_SCALE],
      ),
    [],
  )
  return <Line points={points} color={MOON_RING_COLOR} transparent opacity={0.15} lineWidth={1} />
}

/** Flat circular ring for a non-Earth planet's moon — matches the circular
 * approximation <PlanetMoon> itself moves along, so the ring and the moon
 * always line up exactly. */
function MoonOrbitCircle({ radius }: { radius: number }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[radius - 0.004, radius + 0.004, 64]} />
      <meshBasicMaterial color={MOON_RING_COLOR} transparent opacity={0.15} side={BackSide} />
    </mesh>
  )
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

type CometConfig = { key: CometKey; label: string; color: string }

// Pale icy blue-white — deliberately outside the reserved status palette
// (dataviz skill) and the asteroid-type categorical colors, since comets are
// a visually distinct category (glowing coma, not a flat-shaded sphere) that
// never appears alongside those in a single legend.
const COMETS: CometConfig[] = [
  { key: 'halley', label: "Halley's Comet", color: '#bfe3ff' },
  { key: 'encke', label: 'Comet Encke', color: '#bfe3ff' },
  { key: 'churyumovGerasimenko', label: '67P/Churyumov–Gerasimenko', color: '#bfe3ff' },
]

function cometInfo(config: CometConfig): SelectedInfo {
  const elements = COMET_ELEMENTS[config.key]
  const periodYears = 360 / elements.meanMotionDegPerDay / 365.25
  return {
    title: config.label,
    subtitle: 'Periodic comet — real JPL orbital elements',
    rows: [
      { label: 'Orbital period', value: `${periodYears.toFixed(1)} years` },
      { label: 'Eccentricity', value: elements.eccentricity.toFixed(3) },
      { label: 'Semi-major axis', value: `${elements.semiMajorAxisAu.toFixed(2)} AU` },
      { label: 'Inclination', value: `${elements.inclinationDeg.toFixed(1)}°` },
    ],
  }
}

/** Real periodic comets from JPL's Small-Body Database, propagated with the
 * same Keplerian solver as the planets — their orbits are just far more
 * eccentric/inclined (Halley's e=0.97 is why solveEccentricAnomaly got a
 * better initial guess and more iterations above). Rendered as a small
 * nucleus plus an additive glow shell standing in for the coma; no physically
 * simulated tail. */
function Comet({ config }: { config: CometConfig }) {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()
  const elements = COMET_ELEMENTS[config.key]

  useFrame(() => {
    if (!groupRef.current) return
    const pos = heliocentricPosition(elements, clockRef.current)
    const [x, y, z] = toScenePosition(pos)
    groupRef.current.position.set(x, y, z)
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(cometInfo(config), groupRef.current)
  }

  return (
    <group ref={groupRef} onClick={handleClick}>
      <mesh>
        <sphereGeometry args={[0.02, 12, 12]} />
        <meshBasicMaterial color={config.color} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshBasicMaterial
          color={config.color}
          transparent
          opacity={0.35}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <ClickTarget onClick={handleClick} />
    </group>
  )
}

function CometField() {
  return (
    <>
      {COMETS.map((config) => (
        <OrbitRing key={`comet-ring-${config.key}`} elements={COMET_ELEMENTS[config.key]} color={config.color} />
      ))}
      {COMETS.map((config) => (
        <Comet key={config.key} config={config} />
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

/** Larger invisible hit-target sitting on top of the small visible marker —
 * asteroids render at true relative scale (often a few pixels), which was
 * unclickable on a touchscreen. The tap target is generously sized;
 * the visible sphere keeps its accurate size. */
function ClickTarget({ onClick }: { onClick: (event: ThreeEvent<MouseEvent>) => void }) {
  return (
    <mesh onClick={onClick}>
      <sphereGeometry args={[0.22, 8, 8]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

function HelioNeoMarker({ neo }: { neo: NearEarthObject }) {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()
  const radius = Math.min(0.12, Math.max(0.02, neo.estimatedDiameterKm * 0.05))
  const color = neo.isPotentiallyHazardous ? STATUS_HAZARDOUS : STATUS_SAFE
  const orbit = neo.orbit as OrbitalElements

  useFrame(() => {
    if (!groupRef.current) return
    const pos = heliocentricPosition(orbit, clockRef.current)
    const [x, y, z] = toScenePosition(pos)
    groupRef.current.position.set(x, y, z)
  })

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation()
      select(neoInfo(neo), groupRef.current)
    },
    [neo, select],
  )

  return (
    <>
      {/* Fainter than a planet ring, colored by the same hazard status as
          the marker itself — reuses the reserved status palette rather than
          introducing a new ring color for asteroids. */}
      <OrbitRing elements={orbit} color={color} opacity={0.12} />
      <group ref={groupRef}>
        <mesh>
          <sphereGeometry args={[radius, 12, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
        </mesh>
        <ClickTarget onClick={handleClick} />
      </group>
    </>
  )
}

/** Static tilted circle matching a <FallbackNeoMarker>'s schematic orbit
 * (radius/phi, no real elements) — fainter still than a real-orbit ring, a
 * visual cue that this path is approximated, not measured. */
function FallbackOrbitRing({ orbit, color }: { orbit: FallbackOrbit; color: string }) {
  const points = useMemo(() => {
    const segments = 96
    const pts: [number, number, number][] = []
    for (let i = 0; i <= segments; i += 1) {
      const theta = (i / segments) * Math.PI * 2
      pts.push([
        orbit.radius * Math.cos(orbit.phi) * Math.cos(theta),
        orbit.radius * Math.sin(orbit.phi),
        orbit.radius * Math.cos(orbit.phi) * Math.sin(theta),
      ])
    }
    return pts
  }, [orbit])
  return <Line points={points} color={color} transparent opacity={0.08} lineWidth={1} />
}

/** Earth-relative schematic placement — deliberately NOT inside
 * <HeliocentricFrame>, since without real elements there's no heliocentric
 * position to put there. */
function FallbackNeoMarker({ neo, index }: { neo: NearEarthObject; index: number }) {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const radius = Math.min(0.12, Math.max(0.02, neo.estimatedDiameterKm * 0.05))
  const color = neo.isPotentiallyHazardous ? STATUS_HAZARDOUS : STATUS_SAFE
  const orbit = useMemo(() => fallbackOrbit(neo, index), [neo, index])

  useFrame((state) => {
    if (!groupRef.current) return
    const theta = orbit.theta0 + state.clock.elapsedTime * orbit.angularSpeed
    groupRef.current.position.set(
      orbit.radius * Math.cos(orbit.phi) * Math.cos(theta),
      orbit.radius * Math.sin(orbit.phi),
      orbit.radius * Math.cos(orbit.phi) * Math.sin(theta),
    )
  })

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation()
      select(neoInfo(neo), groupRef.current)
    },
    [neo, select],
  )

  return (
    <>
      <FallbackOrbitRing orbit={orbit} color={color} />
      <group ref={groupRef}>
        <mesh>
          <sphereGeometry args={[radius, 12, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
        </mesh>
        <ClickTarget onClick={handleClick} />
      </group>
    </>
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

/** Simple procedural silhouette (central truss + solar-panel wings) instead
 * of a plain ring — reads as "a station," not just a generic marker. NASA's
 * official ISS model exists (science.nasa.gov) but is a 42MB glTF, too heavy
 * to load into a scene meant to run on a phone; a real lightweight model is
 * a good follow-up if that trade-off is worth it later. */
function StationMarker({
  position,
  fix,
}: {
  position: [number, number, number]
  fix: IssPosition
}) {
  const ref = useRef<Group>(null)
  const select = useSelect()
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.4
  })

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation()
      select(
        {
          title: 'ISS',
          subtitle: 'International Space Station — live',
          rows: [
            { label: 'Altitude', value: `${fix.altitudeKm.toFixed(0)} km` },
            { label: 'Velocity', value: `${fix.velocityKmH.toFixed(0)} km/h` },
            { label: 'Latitude', value: fix.latitude.toFixed(2) },
            { label: 'Longitude', value: fix.longitude.toFixed(2) },
          ],
        },
        ref.current,
      )
    },
    [fix, select],
  )

  return (
    <group ref={ref} position={position}>
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.008, 0.008, 0.09, 8]} />
        <meshStandardMaterial color={TYPE_STATION} emissive={TYPE_STATION} emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[0.055, 0, 0]}>
        <boxGeometry args={[0.05, 0.018, 0.002]} />
        <meshStandardMaterial color={TYPE_STATION} emissive={TYPE_STATION} emissiveIntensity={0.8} />
      </mesh>
      <mesh position={[-0.055, 0, 0]}>
        <boxGeometry args={[0.05, 0.018, 0.002]} />
        <meshStandardMaterial color={TYPE_STATION} emissive={TYPE_STATION} emissiveIntensity={0.8} />
      </mesh>
      <ClickTarget onClick={handleClick} />
    </group>
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
  const [x, y, z] = latLonAltToPosition(fix.latitude, fix.longitude, fix.altitudeKm)
  const position: [number, number, number] = [x * EARTH_RADIUS, y * EARTH_RADIUS, z * EARTH_RADIUS]
  return <StationMarker position={position} fix={fix} />
}

// ---------------------------------------------------------------------------
// HUD: legend + time-speed control
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
    { color: TYPE_SATELLITE, shape: 'rounded-full', label: 'Starlink constellation — live TLE' },
    { color: TYPE_SHUTTLE, shape: 'rounded-full', label: 'shuttle — tracking pending' },
  ]

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1 rounded border border-white/25 bg-[#0a0a0d]/90 px-3 py-2 font-mono text-xs text-white/80 shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md">
      <p className="text-white/50">
        {neoCount} near-Earth objects · {trackedCount} on real heliocentric orbits
      </p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 ${row.shape}`} style={{ background: row.color }} />
          {row.label}
        </p>
      ))}
      <p className="text-white/40">Tap an object for details &amp; focus</p>
    </div>
  )
}

type SpeedMode = 'realtime' | 'accelerated' | 'fast'

const SPEED_MODES: Record<SpeedMode, { label: string; daysPerSecond: number }> = {
  realtime: { label: 'Real-time', daysPerSecond: REALTIME_DAYS_PER_SECOND },
  accelerated: { label: '8 d/s', daysPerSecond: ACCELERATED_DAYS_PER_SECOND },
  fast: { label: '45 d/s', daysPerSecond: FAST_DAYS_PER_SECOND },
}

function SatelliteToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`pointer-events-auto absolute right-3 top-16 rounded border border-white/25 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.08em] shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md ${
        visible ? 'bg-white/20 text-white' : 'bg-[#0a0a0d]/90 text-white/70 hover:bg-white/10'
      }`}
    >
      {visible ? 'Hide satellites' : 'Show satellites'}
    </button>
  )
}

function TimeControl({ speedRef }: { speedRef: SpeedRef }) {
  const [mode, setMode] = useState<SpeedMode>('accelerated')

  return (
    <div className="pointer-events-auto absolute bottom-4 right-4 flex gap-1 rounded border border-white/25 bg-[#0a0a0d]/90 p-1 font-mono text-[0.65rem] uppercase tracking-[0.08em] text-white/70 shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md">
      {(Object.keys(SPEED_MODES) as SpeedMode[]).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => {
            setMode(key)
            speedRef.current = SPEED_MODES[key].daysPerSecond
          }}
          className={`min-h-8 px-2 ${mode === key ? 'bg-white/20 text-white' : 'hover:bg-white/10'}`}
        >
          {SPEED_MODES[key].label}
        </button>
      ))}
    </div>
  )
}

export function EarthScene() {
  const [objects, setObjects] = useState<NearEarthObject[]>([])
  const [issTracked, setIssTracked] = useState(false)
  const [showSatellites, setShowSatellites] = useState(true)
  const [selected, setSelected] = useState<SelectedInfo | null>(null)
  const [focusTarget, setFocusTarget] = useState<Object3D | null>(null)
  // A plain mutable box, not a React ref — the time-speed toggle mutates it
  // directly and useFrame callbacks read it every frame; it never drives
  // this component's own render output.
  const speedBox = useMemo<SpeedRef>(() => ({ current: ACCELERATED_DAYS_PER_SECOND }), [])
  const controlsRef = useRef<OrbitControlsImpl>(null)

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

  const select = useCallback((info: SelectedInfo, target?: Object3D | null) => {
    setSelected(info)
    setFocusTarget(target ?? null)
  }, [])

  const trackedObjects = objects.filter((neo) => neo.orbit !== null)
  const fallbackObjects = objects.filter((neo) => neo.orbit === null)

  return (
    <SelectionContext.Provider value={select}>
      <div className="relative h-full w-full">
        <Canvas
          camera={{ position: [3, 2, 9], fov: 45, near: 0.01, far: 200 }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          dpr={[1, 2]}
          onPointerMissed={() => {
            setSelected(null)
            setFocusTarget(null)
          }}
        >
          <SimulationClockProvider speedRef={speedBox}>
            {/* SunLight is the only light in the scene — no ambient fill. */}
            <SunLight />
            <Earth />
            <MoonOrbitRing />
            <Moon />
            <HeliocentricFrame>
              <Sun />
              <InnerSolarSystem />
              <CometField />
              <HelioNeoField objects={trackedObjects} />
            </HeliocentricFrame>
            <FallbackNeoField objects={fallbackObjects} />
            <IssTracker onFix={() => setIssTracked(true)} />
            <SatelliteConstellation visible={showSatellites} />
            <CameraFocus target={focusTarget} controlsRef={controlsRef} />
          </SimulationClockProvider>
          <Stars radius={80} depth={40} count={3000} factor={3} fade />
          <OrbitControls ref={controlsRef} enablePan minDistance={0.7} maxDistance={60} />
        </Canvas>
        <TypeLegend neoCount={objects.length} trackedCount={trackedObjects.length} issTracked={issTracked} />
        <SatelliteToggle visible={showSatellites} onToggle={() => setShowSatellites((v) => !v)} />
        <TimeControl speedRef={speedBox} />
        {selected ? (
          <InfoPanel
            info={selected}
            onClose={() => {
              setSelected(null)
              setFocusTarget(null)
            }}
          />
        ) : null}
      </div>
    </SelectionContext.Provider>
  )
}
