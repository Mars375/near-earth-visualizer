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
import { Html, Line, OrbitControls, Stars, useGLTF, useTexture } from '@react-three/drei'
import {
  AdditiveBlending,
  BackSide,
  Box3,
  IcosahedronGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
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
  DWARF_PLANET_ELEMENTS,
  NAMED_ASTEROID_ELEMENTS,
  PLANETARY_ELEMENTS,
  earthHeliocentricPosition,
  heliocentricPosition,
  MOON_SEMI_MAJOR_AXIS_EARTH_RADII,
  moonGeocentricPositionEarthRadii,
  moonOrbitalElements,
  orbitPathPoints,
  subtract,
  unixMsToJulianDate,
  jwstPosition,
  voyagerPosition,
  type CometKey,
  type DwarfPlanetKey,
  type NamedAsteroidKey,
  type OrbitalElements,
  type PlanetKey,
  type VoyagerKey,
} from '@/lib/orbitalMechanics'
import { latLonAltToPosition, type IssPosition } from '@/lib/spaceObjects'
import { SatelliteConstellation } from './SatelliteConstellation'
import { eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js'

// Status colors from the dataviz skill's fixed status palette — reserved for
// the asteroid hazard flag only, never reused for arbitrary series identity.
const STATUS_HAZARDOUS = '#d03b3b' // critical
const STATUS_SAFE = '#0ca30c' // good

// Near-Earth object markers only ever need one of two materials (hazardous/
// safe) and one sphere shape (real size varies, so it's applied via mesh
// scale, not a distinct geometry per object) — a NASA feed can return
// several dozen objects a day, so sharing these instead of instantiating
// per-marker avoids dozens of redundant GPU resources.
const NEO_MARKER_GEOMETRY = new SphereGeometry(1, 12, 12)
const NEO_MATERIAL_HAZARDOUS = new MeshStandardMaterial({
  color: STATUS_HAZARDOUS,
  emissive: STATUS_HAZARDOUS,
  emissiveIntensity: 0.4,
})
const NEO_MATERIAL_SAFE = new MeshStandardMaterial({
  color: STATUS_SAFE,
  emissive: STATUS_SAFE,
  emissiveIntensity: 0.4,
})

// Categorical object-type colors — 2 of the dataviz skill's default palette
// slots, validated for the all-pairs CVD check (any two markers can sit side
// by side here, so the adjacent-only check isn't enough).
// Validated: node validate_palette.js "#3987e5,#d95926,#199e70" --mode dark
// --surface "#000000" --pairs all -> ALL CHECKS PASS.
const TYPE_SATELLITE = '#3987e5' // blue
const TYPE_STATION = '#199e70' // aqua

const AU_IN_KM = 149_597_870.7
const EARTH_RADIUS = 0.5 // scene units — was an oversized 1

// ISS/Hubble's real LEO altitude is only ~7-8% of Earth's own radius — at
// true scale their marker, click target, and label all sit essentially on
// Earth's surface, unclickable and visually indistinguishable from it.
// Boosts the altitude portion of their position (not the whole radius) so
// they visibly clear the surface — the same "artistic distance for
// visibility" trade-off already used for the Moon's orbit, just expanding a
// too-small real gap instead of compressing a too-large one.
const NEAR_EARTH_ALTITUDE_BOOST = 8

// The Moon's real distance is ~60 Earth radii — at true scale (60 * 0.5 =
// 30 scene units) it would land out past Jupiter's orbit, invisible next to
// Earth. Compressed to a fixed scene-unit distance instead, same "subway
// map" trade-off as the outer-planet compression above.
const MOON_SCENE_ORBIT_RADIUS = 1.8
const MOON_ORBIT_SCALE = MOON_SCENE_ORBIT_RADIUS / MOON_SEMI_MAJOR_AXIS_EARTH_RADII

// Earth's own Moon ring — other planets' moon rings instead reuse each
// moon's own marker color (see MoonOrbitCircle), so this one just needs to
// read as "grey rock" and sit apart from the Earth-ring blue (#3987e5).
const MOON_RING_COLOR = '#aab2bd'
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
const ACCELERATED_DAYS_PER_SECOND = 3 // default on load — was 8, too fast to read as motion rather than a blur
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
  clockRef,
  children,
}: {
  speedRef: SpeedRef
  clockRef: ClockRef
  children: React.ReactNode
}) {
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

const SelectionContext = createContext<(info: SelectedInfo, target?: Object3D | null, radius?: number) => void>(
  () => {},
)

function useSelect() {
  return useContext(SelectionContext)
}

// ---------------------------------------------------------------------------
// Object registry — every selectable object registers itself here so the
// jump-to menu can list and select anything without relying on the user
// precisely tapping a (sometimes tiny, sometimes fast-moving) 3D target.
// ---------------------------------------------------------------------------

type RegistryEntry = { key: string; label: string; category: string; onSelect: () => void }

const RegistryContext = createContext<{
  register: (entry: RegistryEntry) => void
  unregister: (key: string) => void
} | null>(null)

/** Registers on mount, unregisters on unmount — `onSelect` is read fresh
 * each render via a ref so the registry entry never goes stale without
 * needing to re-register every time (e.g. when `select` or the object's
 * own info changes identity). */
function useRegisterObject(entry: RegistryEntry) {
  const ctx = useContext(RegistryContext)
  const entryRef = useRef(entry)

  useEffect(() => {
    entryRef.current = entry
  })

  useEffect(() => {
    if (!ctx) return
    const stableEntry: RegistryEntry = {
      key: entry.key,
      label: entry.label,
      category: entry.category,
      onSelect: () => entryRef.current.onSelect(),
    }
    ctx.register(stableEntry)
    return () => ctx.unregister(entry.key)
  }, [ctx, entry.key, entry.label, entry.category])
}

function RegistryProvider({
  children,
  onEntriesChange,
}: {
  children: React.ReactNode
  onEntriesChange: (entries: RegistryEntry[]) => void
}) {
  const entriesRef = useRef<RegistryEntry[]>([])

  const register = useCallback(
    (entry: RegistryEntry) => {
      entriesRef.current = [...entriesRef.current.filter((e) => e.key !== entry.key), entry]
      onEntriesChange(entriesRef.current)
    },
    [onEntriesChange],
  )
  const unregister = useCallback(
    (key: string) => {
      entriesRef.current = entriesRef.current.filter((e) => e.key !== key)
      onEntriesChange(entriesRef.current)
    },
    [onEntriesChange],
  )

  const ctxValue = useMemo(() => ({ register, unregister }), [register, unregister])

  return <RegistryContext.Provider value={ctxValue}>{children}</RegistryContext.Provider>
}

function InfoPanel({ info, onClose }: { info: SelectedInfo; onClose: () => void }) {
  return (
    <div className="pointer-events-auto absolute right-4 top-[97px] w-64 rounded border border-white/25 bg-[#0a0a0d]/90 p-3 font-mono text-xs text-white/85 shadow-[0_2px_16px_rgba(0,0,0,0.6)] backdrop-blur-md">
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

  useFrame(() => {
    if (!target || !controlsRef.current) return
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

// Real axial tilt (23.4393°), fixed in ecliptic space — this codebase's
// heliocentric frame follows the standard astronomical convention (+X toward
// the vernal equinox, XY the ecliptic plane, +Z ecliptic north), unchanged
// by toScenePosition, so this vector applies directly as a scene rotation.
// Without it, the sphere's spin axis was ecliptic-normal (no tilt at all),
// so the day/night shader had no notion of polar night — meanwhile the live
// GIBS day-map texture *does* show real polar night (Antarctica is
// genuinely dark for months around southern winter), baked into the source
// imagery regardless of viewing angle. The mismatch read as a rendering
// defect: a dark smudge sitting on a region our own shader considered "lit."
// Tilting the axis to match reality makes the two agree.
const EARTH_OBLIQUITY_DEG = 23.4393
const EARTH_AXIAL_TILT_QUATERNION = new Quaternion().setFromUnitVectors(
  new Vector3(0, 1, 0),
  new Vector3(
    0,
    Math.sin((EARTH_OBLIQUITY_DEG * Math.PI) / 180),
    Math.cos((EARTH_OBLIQUITY_DEG * Math.PI) / 180),
  ).normalize(),
)

const EARTH_INFO: SelectedInfo = {
  title: 'Earth',
  subtitle: 'Home planet — scene reference point',
  rows: [
    { label: 'Mean radius', value: '6,371 km' },
    { label: 'Orbital period', value: '365.25 days' },
    { label: 'Rotation period', value: '23h 56m' },
  ],
}

function Earth() {
  const meshRef = useRef<Mesh>(null)
  const materialRef = useRef<ShaderMaterial>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()

  useRegisterObject({
    key: 'earth',
    label: 'Earth',
    category: 'Planets',
    onSelect: () => select(EARTH_INFO, meshRef.current, EARTH_RADIUS),
  })
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
      quaternion={EARTH_AXIAL_TILT_QUATERNION}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(EARTH_INFO, meshRef.current, EARTH_RADIUS)
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

  useRegisterObject({
    key: 'moon',
    label: 'Moon',
    category: 'Moons',
    onSelect: () => select(MOON_INFO, groupRef.current, 0.035),
  })

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
        select(MOON_INFO, groupRef.current, 0.035)
      }}
    >
      <mesh>
        <sphereGeometry args={[0.035, 24, 24]} />
        <meshStandardMaterial map={map} roughness={1} />
      </mesh>
      <ClickTarget
        onClick={(event) => {
          event.stopPropagation()
          select(MOON_INFO, groupRef.current, 0.035)
        }}
      />
      <ObjectLabel text="Moon" radius={0.035} />
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

  useRegisterObject({
    key: 'sun',
    label: 'Sun',
    category: 'Sun',
    onSelect: () => select(SUN_INFO, spinRef.current, 0.55),
  })

  useFrame((_, delta) => {
    if (spinRef.current) spinRef.current.rotation.y += delta * 0.03
  })

  // Default camera focus: the Sun selects itself once, on mount, reusing
  // the same click-to-focus system rather than a separate camera path.
  useEffect(() => {
    select(SUN_INFO, spinRef.current, 0.55)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <group
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(SUN_INFO, spinRef.current, 0.55)
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
      <ObjectLabel text="Sun" radius={0.55} />
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
  ringColor: string
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

  const moonInfo: SelectedInfo = {
    title: config.label,
    subtitle: 'Moon — real distance/period, circular-orbit approximation',
    rows: [
      { label: 'Orbital period', value: `${config.periodDays.toFixed(2)} days` },
      { label: 'Mean distance', value: `${config.realDistanceKm.toLocaleString()} km` },
      { label: 'Mean radius', value: `${config.realRadiusKm.toLocaleString()} km` },
    ],
  }

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(moonInfo, groupRef.current, config.renderRadius)
  }

  useRegisterObject({
    key: config.key,
    label: config.label,
    category: 'Moons',
    onSelect: () => select(moonInfo, groupRef.current, config.renderRadius),
  })

  return (
    <group ref={groupRef} onClick={handleClick}>
      <mesh>
        <sphereGeometry args={[config.renderRadius, 12, 12]} />
        <meshStandardMaterial color={config.color} roughness={1} />
      </mesh>
      <ClickTarget onClick={handleClick} />
      <ObjectLabel text={config.label} radius={config.renderRadius} />
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
// Ring colors loosely echo each planet's real surface/cloud tone (Mars'
// rust, Saturn's pale gold, Uranus/Neptune's ice-giant blues) so each ring
// visually pairs with its own planet instead of all 7 sharing one grey.
const PLANETS: PlanetConfig[] = [
  { key: 'mercury', label: 'Mercury', texture: '/textures/2k_mercury.jpg', radius: 0.16, rotationPeriodDays: 58.646, ringColor: '#9c9187' },
  { key: 'venus', label: 'Venus', texture: '/textures/2k_venus_atmosphere.jpg', radius: 0.47, rotationPeriodDays: -243.025, ringColor: '#e0c16c' },
  { key: 'mars', label: 'Mars', texture: '/textures/2k_mars.jpg', radius: 0.24, rotationPeriodDays: 1.02596, moons: MARS_MOONS, ringColor: '#b5541c' },
  { key: 'jupiter', label: 'Jupiter', texture: '/textures/2k_jupiter.jpg', radius: 1.9, rotationPeriodDays: 0.41354, moons: JUPITER_MOONS, ringColor: '#d9a066' },
  { key: 'saturn', label: 'Saturn', texture: '/textures/2k_saturn.jpg', radius: 1.6, rotationPeriodDays: 0.4375, ring: true, moons: SATURN_MOONS, ringColor: '#e3c98f' },
  { key: 'uranus', label: 'Uranus', texture: '/textures/2k_uranus.jpg', radius: 0.78, rotationPeriodDays: -0.71833, ringColor: '#7fd4d1' },
  { key: 'neptune', label: 'Neptune', texture: '/textures/2k_neptune.jpg', radius: 0.75, rotationPeriodDays: 0.6713, ringColor: '#3d5aa8' },
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

  const buildInfo = (): SelectedInfo => {
    const relative = subtract(
      heliocentricPosition(elements, clockRef.current),
      earthHeliocentricPosition(clockRef.current),
    )
    const distanceAu = Math.hypot(relative.x, relative.y, relative.z)
    return {
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
    }
  }

  useRegisterObject({
    key: config.key,
    label: config.label,
    category: 'Planets',
    onSelect: () => select(buildInfo(), spinRef.current, config.radius),
  })

  return (
    <group
      ref={groupRef}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation()
        select(buildInfo(), spinRef.current, config.radius)
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
          <MoonOrbitCircle radius={moon.sceneOrbitRadius} color={moon.color} />
          <PlanetMoon config={moon} />
        </group>
      ))}
      <ObjectLabel text={config.label} radius={config.radius} />
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
    () => orbitPathPoints(elements, 96).map((p) => toScenePosition(p)),
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
      orbitPathPoints(moonOrbitalElements(BASE_JULIAN_DATE), 72).map(
        (p): [number, number, number] => [p.x * MOON_ORBIT_SCALE, p.y * MOON_ORBIT_SCALE, p.z * MOON_ORBIT_SCALE],
      ),
    [],
  )
  return <Line points={points} color={MOON_RING_COLOR} transparent opacity={0.13} lineWidth={1} />
}

/** Flat circular ring for a non-Earth planet's moon — matches the circular
 * approximation <PlanetMoon> itself moves along, so the ring and the moon
 * always line up exactly. Colored to match that moon's own marker, so ring
 * and marker read as one object instead of moons sharing one grey ring. */
function MoonOrbitCircle({ radius, color }: { radius: number; color: string }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[radius - 0.004, radius + 0.004, 64]} />
      <meshBasicMaterial color={color} transparent opacity={0.13} side={BackSide} />
    </mesh>
  )
}

function InnerSolarSystem() {
  return (
    <>
      <OrbitRing elements={PLANETARY_ELEMENTS.earth} color="#3987e5" opacity={0.22} />
      {PLANETS.map((config) => (
        <OrbitRing key={`ring-${config.key}`} elements={PLANETARY_ELEMENTS[config.key]} color={config.ringColor} opacity={0.2} />
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
  { key: 'encke', label: 'Comet Encke', color: '#9fd8f5' },
  // 67P is genuinely one of the darkest bodies known (albedo ~0.06, darker
  // than coal) — a dusty grey-brown reads truer than the icy-blue treatment
  // shared by Halley/Encke, not just a differentiator.
  { key: 'churyumovGerasimenko', label: '67P/Churyumov–Gerasimenko', color: '#8a8378' },
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

// A comet's tail always points radially away from the Sun (solar wind/
// radiation pressure push it outward, regardless of the comet's direction
// of travel) — the Sun sits at the heliocentric origin, so "away from Sun"
// is just the comet's own position vector, normalized. Rendered as a fixed
// segment rotated to that direction each frame rather than an evolving
// particle sim.
const COMET_TAIL_LENGTH = 0.35
const COMET_TAIL_AXIS = new Vector3(1, 0, 0)

// Deterministic string -> int hash, just to seed each comet's nucleus shape
// consistently across renders/reloads without needing to store random state.
function hashSeed(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) | 0
  return h
}

function seededRandom(seed: number): () => number {
  let t = seed
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// None of these three comets has ever been imaged closely enough for a real
// shape model (unlike 67P, which Rosetta mapped in detail — not reachable
// from this build environment, and a spacecraft model isn't the comet
// itself anyway) — a lumpy, irregular nucleus is still truer to a real
// comet than a perfect sphere, so vertices of an icosahedron are displaced
// by a per-comet deterministic seed instead of faking mission-derived data.
function useIrregularNucleusGeometry(seed: number, radius: number) {
  return useMemo(() => {
    const geometry = new IcosahedronGeometry(radius, 2)
    const random = seededRandom(seed)
    const position = geometry.attributes.position
    const vertex = new Vector3()
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i)
      vertex.multiplyScalar(0.65 + random() * 0.55)
      position.setXYZ(i, vertex.x, vertex.y, vertex.z)
    }
    geometry.computeVertexNormals()
    return geometry
  }, [seed, radius])
}

/** Real periodic comets from JPL's Small-Body Database, propagated with the
 * same Keplerian solver as the planets — their orbits are just far more
 * eccentric/inclined (Halley's e=0.97 is why solveEccentricAnomaly got a
 * better initial guess and more iterations above). Rendered as a small
 * nucleus, an additive glow shell standing in for the coma, and a tail
 * pointing away from the Sun. */
function Comet({ config }: { config: CometConfig }) {
  const groupRef = useRef<Group>(null)
  const tailRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()
  const elements = COMET_ELEMENTS[config.key]
  const awayFromSun = useMemo(() => new Vector3(), [])
  const nucleusGeometry = useIrregularNucleusGeometry(hashSeed(config.key), 0.022)

  useFrame(() => {
    if (!groupRef.current) return
    const pos = heliocentricPosition(elements, clockRef.current)
    const [x, y, z] = toScenePosition(pos)
    groupRef.current.position.set(x, y, z)
    if (tailRef.current) {
      awayFromSun.set(x, y, z).normalize()
      tailRef.current.quaternion.setFromUnitVectors(COMET_TAIL_AXIS, awayFromSun)
    }
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(cometInfo(config), groupRef.current, 0.06)
  }

  useRegisterObject({
    key: config.key,
    label: config.label,
    category: 'Comets',
    onSelect: () => select(cometInfo(config), groupRef.current, 0.06),
  })

  return (
    <group ref={groupRef} onClick={handleClick}>
      <mesh geometry={nucleusGeometry}>
        <meshStandardMaterial color={config.color} roughness={0.95} />
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
      <group ref={tailRef}>
        <Line
          points={[
            [0, 0, 0],
            [COMET_TAIL_LENGTH, 0, 0],
          ]}
          color={config.color}
          transparent
          opacity={0.3}
          lineWidth={1.5}
        />
      </group>
      <ClickTarget onClick={handleClick} />
      <ObjectLabel text={config.label} radius={0.06} />
    </group>
  )
}

function CometField() {
  return (
    <>
      {COMETS.map((config) => (
        <OrbitRing key={`comet-ring-${config.key}`} elements={COMET_ELEMENTS[config.key]} color={config.color} opacity={0.16} />
      ))}
      {COMETS.map((config) => (
        <Comet key={config.key} config={config} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Dwarf planets — real JPL orbital elements, same Kepler pipeline as the
// planets/comets above (moderate eccentricities, nothing the solver needs
// hardening for).
// ---------------------------------------------------------------------------

type DwarfPlanetConfig = { key: DwarfPlanetKey; label: string; color: string }

// Colors echo each body's own real surface tone: Pluto's ruddy tan
// (tholins), Ceres' dark neutral grey (carbonaceous), Eris' near-white —
// it's genuinely one of the most reflective bodies in the solar system
// (methane-ice surface), not a picked accent.
const DWARF_PLANETS: DwarfPlanetConfig[] = [
  { key: 'pluto', label: 'Pluto', color: '#c9a876' },
  { key: 'ceres', label: 'Ceres', color: '#9a958c' },
  { key: 'eris', label: 'Eris', color: '#e8e6e0' },
]

function dwarfPlanetInfo(config: DwarfPlanetConfig): SelectedInfo {
  const elements = DWARF_PLANET_ELEMENTS[config.key]
  const periodYears = 360 / elements.meanMotionDegPerDay / 365.25
  return {
    title: config.label,
    subtitle: 'Dwarf planet — real JPL orbital elements',
    rows: [
      { label: 'Orbital period', value: `${periodYears.toFixed(0)} years` },
      { label: 'Eccentricity', value: elements.eccentricity.toFixed(3) },
      { label: 'Semi-major axis', value: `${elements.semiMajorAxisAu.toFixed(2)} AU` },
      { label: 'Inclination', value: `${elements.inclinationDeg.toFixed(1)}°` },
    ],
  }
}

function DwarfPlanet({ config }: { config: DwarfPlanetConfig }) {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()
  const elements = DWARF_PLANET_ELEMENTS[config.key]

  useFrame(() => {
    if (!groupRef.current) return
    const pos = heliocentricPosition(elements, clockRef.current)
    const [x, y, z] = toScenePosition(pos)
    groupRef.current.position.set(x, y, z)
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(dwarfPlanetInfo(config), groupRef.current, 0.06)
  }

  useRegisterObject({
    key: config.key,
    label: config.label,
    category: 'Dwarf planets',
    onSelect: () => select(dwarfPlanetInfo(config), groupRef.current, 0.06),
  })

  return (
    <group ref={groupRef} onClick={handleClick}>
      <mesh>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshStandardMaterial color={config.color} roughness={0.9} />
      </mesh>
      <ClickTarget onClick={handleClick} />
      <ObjectLabel text={config.label} radius={0.06} />
    </group>
  )
}

function DwarfPlanetField() {
  return (
    <>
      {DWARF_PLANETS.map((config) => (
        <OrbitRing key={`dwarf-ring-${config.key}`} elements={DWARF_PLANET_ELEMENTS[config.key]} color={config.color} opacity={0.14} />
      ))}
      {DWARF_PLANETS.map((config) => (
        <DwarfPlanet key={config.key} config={config} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Named asteroids — real JPL orbital elements, same Kepler pipeline as the
// dwarf planets above, but rendered with their actual mission-derived shape
// models (Bennu: OSIRIS-REx laser altimetry; Itokawa: Hayabusa) instead of a
// generic sphere — both are famously irregular, non-spherical bodies, so a
// sphere marker would misrepresent them.
// ---------------------------------------------------------------------------

type NamedAsteroidConfig = { key: NamedAsteroidKey; label: string; modelUrl: string; targetSize: number }

const NAMED_ASTEROIDS: NamedAsteroidConfig[] = [
  { key: 'bennu', label: 'Bennu', modelUrl: '/models/bennu.glb', targetSize: 0.05 },
  { key: 'itokawa', label: 'Itokawa', modelUrl: '/models/itokawa.glb', targetSize: 0.05 },
]

useGLTF.preload('/models/bennu.glb')
useGLTF.preload('/models/itokawa.glb')

function NamedAsteroidModel({ url, targetSize }: { url: string; targetSize: number }) {
  const model = useNormalizedModel(url, targetSize, '#8a8579', 0.1)
  return <primitive object={model} />
}

function namedAsteroidInfo(config: NamedAsteroidConfig): SelectedInfo {
  const elements = NAMED_ASTEROID_ELEMENTS[config.key]
  const periodYears = 360 / elements.meanMotionDegPerDay / 365.25
  return {
    title: config.label,
    subtitle: 'Near-Earth asteroid — real shape model, real JPL orbit',
    rows: [
      { label: 'Orbital period', value: `${periodYears.toFixed(2)} years` },
      { label: 'Eccentricity', value: elements.eccentricity.toFixed(3) },
      { label: 'Semi-major axis', value: `${elements.semiMajorAxisAu.toFixed(2)} AU` },
      { label: 'Inclination', value: `${elements.inclinationDeg.toFixed(1)}°` },
    ],
  }
}

function NamedAsteroid({ config }: { config: NamedAsteroidConfig }) {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()
  const elements = NAMED_ASTEROID_ELEMENTS[config.key]

  useFrame(() => {
    if (!groupRef.current) return
    const pos = heliocentricPosition(elements, clockRef.current)
    const [x, y, z] = toScenePosition(pos)
    groupRef.current.position.set(x, y, z)
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(namedAsteroidInfo(config), groupRef.current, config.targetSize)
  }

  useRegisterObject({
    key: config.key,
    label: config.label,
    category: 'Asteroids',
    onSelect: () => select(namedAsteroidInfo(config), groupRef.current, config.targetSize),
  })

  return (
    <group ref={groupRef} onClick={handleClick}>
      <NamedAsteroidModel url={config.modelUrl} targetSize={config.targetSize} />
      <ClickTarget onClick={handleClick} small />
      <ObjectLabel text={config.label} radius={config.targetSize} />
    </group>
  )
}

function NamedAsteroidField() {
  return (
    <>
      {NAMED_ASTEROIDS.map((config) => (
        <OrbitRing
          key={`asteroid-ring-${config.key}`}
          elements={NAMED_ASTEROID_ELEMENTS[config.key]}
          color="#8a8579"
          opacity={0.14}
        />
      ))}
      {NAMED_ASTEROIDS.map((config) => (
        <NamedAsteroid key={config.key} config={config} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Voyager 1 & 2 — real distance/direction/speed, modeled as linear radial
// motion (see voyagerPosition in orbitalMechanics.ts for why that's a fair
// model this far out). No orbit ring: these aren't on a closed orbit, and
// drawing one would wrongly imply periodicity.
// ---------------------------------------------------------------------------

type VoyagerConfig = { key: VoyagerKey; label: string; color: string; heading: string }

// Colors echo each probe's own real thermal-blanket tone at a glance —
// V1's is a warmer gold, V2's a cooler silver-blue — rather than a shared
// arbitrary "probe" color.
const VOYAGERS: VoyagerConfig[] = [
  { key: 'voyager1', label: 'Voyager 1', color: '#e8d5a3', heading: 'toward Ophiuchus' },
  { key: 'voyager2', label: 'Voyager 2', color: '#b9c9db', heading: 'toward Pavo' },
]

// Real NASA/JPL VTAD model — public domain, "twin Voyager spacecraft" is one
// shared model since the two probes are physically identical builds, not a
// simplification. Reused for both instances, tinted per-probe.
const VOYAGER_MODEL_URL = '/models/voyager.glb'
const VOYAGER_TARGET_SIZE = 0.09

useGLTF.preload(VOYAGER_MODEL_URL)

function VoyagerModel({ color }: { color: string }) {
  const model = useNormalizedModel(VOYAGER_MODEL_URL, VOYAGER_TARGET_SIZE, color, 0.2)
  return <primitive object={model} />
}

function voyagerInfo(config: VoyagerConfig): SelectedInfo {
  return {
    title: config.label,
    subtitle: `Launched 1977 — real trajectory, linear radial model`,
    rows: [
      { label: 'Heading', value: config.heading },
      { label: 'Status', value: 'Interstellar space' },
      { label: 'Note', value: 'Distance grows in real time, live map' },
    ],
  }
}

/** Small flat dish + body — evokes the probes' real distinctive antenna
 * silhouette without a full 3D model. */
function Voyager({ config }: { config: VoyagerConfig }) {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()

  useFrame(() => {
    if (!groupRef.current) return
    const pos = voyagerPosition(config.key, clockRef.current)
    const [x, y, z] = toScenePosition(pos)
    groupRef.current.position.set(x, y, z)
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(voyagerInfo(config), groupRef.current, VOYAGER_TARGET_SIZE)
  }

  useRegisterObject({
    key: config.key,
    label: config.label,
    category: 'Deep space',
    onSelect: () => select(voyagerInfo(config), groupRef.current, VOYAGER_TARGET_SIZE),
  })

  return (
    <group ref={groupRef} onClick={handleClick}>
      <VoyagerModel color={config.color} />
      <ClickTarget onClick={handleClick} small />
      <ObjectLabel text={config.label} radius={VOYAGER_TARGET_SIZE} />
    </group>
  )
}

function VoyagerField() {
  return (
    <>
      {VOYAGERS.map((config) => (
        <Voyager key={config.key} config={config} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// JWST — real position at the Sun-Earth L2 point (see jwstPosition in
// orbitalMechanics.ts for the fixed-point-vs-halo-orbit simplification).
// Lives inside <HeliocentricFrame> like the planets/comets, not as an
// Earth-geocentric sibling — its offset is heliocentric-scale AU math, not
// a lat/lon/altitude fix like the ISS.
// ---------------------------------------------------------------------------

const JWST_MODEL_URL = '/models/jwst.glb'
const JWST_TARGET_SIZE = 0.1
const JWST_COLOR = '#e8d9b8' // real gold-coated beryllium mirror segments
const JWST_SCENE_BOOST = 15

useGLTF.preload(JWST_MODEL_URL)

function JwstModel() {
  const model = useNormalizedModel(JWST_MODEL_URL, JWST_TARGET_SIZE, JWST_COLOR, 0.2)
  return <primitive object={model} />
}

const JWST_INFO: SelectedInfo = {
  title: 'JWST',
  subtitle: 'James Webb Space Telescope — Sun-Earth L2 point',
  rows: [
    { label: 'Distance from Earth', value: '~1.5M km (L2)' },
    { label: 'Launched', value: '2021' },
    { label: 'Note', value: 'Real point, not real halo orbit' },
  ],
}

function Jwst() {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const clockRef = useSimulationClock()

  useFrame(() => {
    if (!groupRef.current) return
    const pos = jwstPosition(clockRef.current, JWST_SCENE_BOOST)
    const [x, y, z] = toScenePosition(pos)
    groupRef.current.position.set(x, y, z)
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(JWST_INFO, groupRef.current, JWST_TARGET_SIZE)
  }

  useRegisterObject({
    key: 'jwst',
    label: 'JWST',
    category: 'Deep space',
    onSelect: () => select(JWST_INFO, groupRef.current, JWST_TARGET_SIZE),
  })

  return (
    <group ref={groupRef} onClick={handleClick}>
      <JwstModel />
      <ClickTarget onClick={handleClick} small />
      <ObjectLabel text="JWST" radius={JWST_TARGET_SIZE} stackIndex={2} />
    </group>
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

// Every clickable object (planets, moons, comets, asteroids, ISS — dozens of
// instances) mounts one of these. Identical geometry/material each time, so
// one shared pair is created once at module scope instead of once per
// instance — cuts what would be dozens of redundant GPU resources to one.
const CLICK_TARGET_GEOMETRY = new SphereGeometry(0.22, 8, 8)
const CLICK_TARGET_MATERIAL = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
// ISS/Hubble orbit only ~7% of Earth's radius above its surface — the
// standard 0.22 hit-target nearly overlaps Earth's own surface there,
// making taps land on Earth instead. A smaller shared target for them.
const CLICK_TARGET_GEOMETRY_SMALL = new SphereGeometry(0.06, 8, 8)

/** Larger invisible hit-target sitting on top of the small visible marker —
 * asteroids render at true relative scale (often a few pixels), which was
 * unclickable on a touchscreen. The tap target is generously sized;
 * the visible sphere keeps its accurate size. */
function ClickTarget({
  onClick,
  small = false,
}: {
  onClick: (event: ThreeEvent<MouseEvent>) => void
  small?: boolean
}) {
  return (
    <mesh
      geometry={small ? CLICK_TARGET_GEOMETRY_SMALL : CLICK_TARGET_GEOMETRY}
      material={CLICK_TARGET_MATERIAL}
      onClick={onClick}
    />
  )
}

/** Floating name tag anchored just above an object's own visual top —
 * without this, most objects are indistinguishable points until tapped.
 * Reserved for headline objects (Sun, planets, Earth's Moon, comets, ISS) —
 * per-moon-of-a-planet or per-asteroid labels would just clutter the view.
 * distanceFactor shrinks the label with distance so it never dominates the
 * frame up close or vanishes zoomed out. */
// Hides the label once the camera is closer than this many multiples of the
// object's own radius — otherwise a label just sits there overlapping the
// object once it's filling most of the screen, which looks wrong rather
// than helpful. A pure multiple of radius made the smallest objects (NEOs,
// comets — radius as low as 0.02) need an absurd amount of zoom before the
// threshold was reached at all, so there's also a flat floor: whichever of
// "N radii" or this fixed distance is bigger wins.
const LABEL_HIDE_DISTANCE_FACTOR = 8
const LABEL_HIDE_DISTANCE_FLOOR = 0.3

// OrbitControls' minDistance (how close the camera can zoom to the current
// orbit target) — comfortably smaller than LABEL_HIDE_DISTANCE_FACTOR so
// there's always a reachable zoom range where a label actually hides,
// whatever object is focused. DEFAULT is the floor used before anything's
// been selected yet (matches the original always-0.7 behavior).
const DEFAULT_MIN_ZOOM_DISTANCE = 0.7
const MIN_ZOOM_DISTANCE_FACTOR = 1.5
const MIN_ZOOM_DISTANCE_FLOOR = 0.05

// Near-Earth objects (ISS, Hubble, JWST) sit close enough together in scene
// space that their labels overlap at typical zoom — not worth a general
// screen-space collision solver for three objects, so each near-Earth label
// takes an optional extra stack rung instead (ponytail: fixed-cluster fix,
// upgrade to real collision avoidance if a 4th near-Earth object joins).
function ObjectLabel({ text, radius, stackIndex = 0 }: { text: string; radius: number; stackIndex?: number }) {
  const groupRef = useRef<Group>(null)
  const worldPos = useMemo(() => new Vector3(), [])
  const [visible, setVisible] = useState(true)

  useFrame((state) => {
    if (!groupRef.current) return
    groupRef.current.getWorldPosition(worldPos)
    const distance = state.camera.position.distanceTo(worldPos)
    const shouldShow = distance > Math.max(radius * LABEL_HIDE_DISTANCE_FACTOR, LABEL_HIDE_DISTANCE_FLOOR)
    if (shouldShow !== visible) setVisible(shouldShow)
  })

  return (
    <group ref={groupRef} position={[0, radius * 1.4 + stackIndex * 0.12, 0]}>
      {visible ? (
        <Html center distanceFactor={10} zIndexRange={[0, 0]}>
          <div className="pointer-events-none select-none whitespace-nowrap rounded bg-black/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-white/75 backdrop-blur-sm">
            {text}
          </div>
        </Html>
      ) : null}
    </group>
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
      select(neoInfo(neo), groupRef.current, radius)
    },
    [neo, select, radius],
  )

  useRegisterObject({
    key: neo.id,
    label: neo.name,
    category: 'Asteroids',
    onSelect: () => select(neoInfo(neo), groupRef.current, radius),
  })

  return (
    <>
      {/* Fainter than a planet ring, colored by the same hazard status as
          the marker itself — reuses the reserved status palette rather than
          introducing a new ring color for asteroids. */}
      <OrbitRing elements={orbit} color={color} opacity={0.1} />
      <group ref={groupRef}>
        <mesh
          geometry={NEO_MARKER_GEOMETRY}
          material={neo.isPotentiallyHazardous ? NEO_MATERIAL_HAZARDOUS : NEO_MATERIAL_SAFE}
          scale={radius}
        />
        <ClickTarget onClick={handleClick} />
        <ObjectLabel text={neo.name} radius={radius} />
      </group>
    </>
  )
}

/** Static tilted circle matching a <FallbackNeoMarker>'s schematic orbit
 * (radius/phi, no real elements) — fainter still than a real-orbit ring, a
 * visual cue that this path is approximated, not measured. */
function FallbackOrbitRing({ orbit, color }: { orbit: FallbackOrbit; color: string }) {
  const points = useMemo(() => {
    const segments = 64
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
  return <Line points={points} color={color} transparent opacity={0.07} lineWidth={1} />
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
      select(neoInfo(neo), groupRef.current, radius)
    },
    [neo, select, radius],
  )

  useRegisterObject({
    key: neo.id,
    label: neo.name,
    category: 'Asteroids',
    onSelect: () => select(neoInfo(neo), groupRef.current, radius),
  })

  return (
    <>
      <FallbackOrbitRing orbit={orbit} color={color} />
      <group ref={groupRef}>
        <mesh
          geometry={NEO_MARKER_GEOMETRY}
          material={neo.isPotentiallyHazardous ? NEO_MATERIAL_HAZARDOUS : NEO_MATERIAL_SAFE}
          scale={radius}
        />
        <ClickTarget onClick={handleClick} />
        <ObjectLabel text={neo.name} radius={radius} />
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

// Real NASA/Ames geometry (nasa/NASA-3D-Resources, public domain — 6,628
// polygons, 38KB as glTF), not a procedural stand-in.
const ISS_MODEL_URL = '/models/iss.glb'
// Scene-unit footprint the real model gets normalized to — not a claim of
// true relative scale (the ISS is ~109m across; at Earth's true relative
// size that'd be sub-pixel).
const ISS_TARGET_SIZE = 0.13

useGLTF.preload(ISS_MODEL_URL)

/** Shared by every real glTF model in the scene (ISS, Hubble): export
 * units/origin aren't known ahead of time, so this measures its own
 * bounding box, uniformly scales the longest axis to targetSize, and
 * recenters on its own centroid rather than the export's arbitrary origin.
 * A faint emissive tint keeps it visible in Earth's shadow without washing
 * out the real geometry. */
function useNormalizedModel(url: string, targetSize: number, tintColor: string, tintIntensity: number): Group {
  const { scene } = useGLTF(url)
  return useMemo(() => {
    const clone = scene.clone(true)
    const box = new Box3().setFromObject(clone)
    const size = new Vector3()
    const center = new Vector3()
    box.getSize(size)
    box.getCenter(center)
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const scale = targetSize / maxDim
    clone.scale.setScalar(scale)
    clone.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
    clone.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.isMesh && mesh.material) {
        const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial
        if (material.emissive) {
          material.emissive.set(tintColor)
          material.emissiveIntensity = tintIntensity
        }
      }
    })
    return clone
  }, [scene, targetSize, tintColor, tintIntensity])
}

function StationModel() {
  const model = useNormalizedModel(ISS_MODEL_URL, ISS_TARGET_SIZE, TYPE_STATION, 0.15)
  return <primitive object={model} />
}

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
    if (ref.current) ref.current.rotation.y += delta * 0.15
  })

  const issInfo: SelectedInfo = {
    title: 'ISS',
    subtitle: 'International Space Station — live',
    rows: [
      { label: 'Altitude', value: `${fix.altitudeKm.toFixed(0)} km` },
      { label: 'Velocity', value: `${fix.velocityKmH.toFixed(0)} km/h` },
      { label: 'Latitude', value: fix.latitude.toFixed(2) },
      { label: 'Longitude', value: fix.longitude.toFixed(2) },
    ],
  }

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation()
      select(issInfo, ref.current, ISS_TARGET_SIZE)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fix, select],
  )

  useRegisterObject({
    key: 'iss',
    label: 'ISS',
    category: 'Deep space',
    onSelect: () => select(issInfo, ref.current, ISS_TARGET_SIZE),
  })

  return (
    <group ref={ref} position={position}>
      <StationModel />
      <ClickTarget onClick={handleClick} small />
      <ObjectLabel text="ISS" radius={ISS_TARGET_SIZE} />
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
  const [x, y, z] = latLonAltToPosition(fix.latitude, fix.longitude, fix.altitudeKm * NEAR_EARTH_ALTITUDE_BOOST)
  const position: [number, number, number] = [x * EARTH_RADIUS, y * EARTH_RADIUS, z * EARTH_RADIUS]
  return <StationMarker position={position} fix={fix} />
}

// ---------------------------------------------------------------------------
// Hubble — real TLE (NORAD 20580) via Celestrak, same satellite.js/SGP4
// pipeline as the Starlink field, just for one object.
// ---------------------------------------------------------------------------

const HUBBLE_MODEL_URL = '/models/hubble.glb'
const HUBBLE_TARGET_SIZE = 0.11
// Real gold-foil thermal blanket — Hubble's own actual color, not a picked
// accent. Deliberately distinct from the ISS's TYPE_STATION aqua.
const HUBBLE_COLOR = '#c9a227'

useGLTF.preload(HUBBLE_MODEL_URL)

function HubbleModel() {
  const model = useNormalizedModel(HUBBLE_MODEL_URL, HUBBLE_TARGET_SIZE, HUBBLE_COLOR, 0.15)
  return <primitive object={model} />
}

const HUBBLE_INFO: SelectedInfo = {
  title: 'Hubble',
  subtitle: 'Hubble Space Telescope — live TLE',
  rows: [
    { label: 'Orbit altitude', value: '~535 km (LEO)' },
    { label: 'Orbital period', value: '~95 min' },
    { label: 'Launched', value: '1990' },
  ],
}

/** Propagated with real orbital state (SGP4), refreshed every frame like the
 * Starlink field — but anchored to real wall-clock time, not the app's
 * adjustable simulation clock, for the same reason as the satellites: a TLE
 * is only valid near its real epoch. */
function Hubble() {
  const groupRef = useRef<Group>(null)
  const select = useSelect()
  const satrecRef = useRef<SatRec | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/hubble')
      .then((res) => res.json())
      .then((data: { tle: { line1: string; line2: string } | null }) => {
        if (cancelled || !data.tle) return
        satrecRef.current = twoline2satrec(data.tle.line1, data.tle.line2)
        setReady(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useFrame(() => {
    if (!groupRef.current || !satrecRef.current) return
    const now = new Date()
    const result = propagate(satrecRef.current, now)
    if (!result || !result.position) return
    const geo = eciToGeodetic(result.position, gstime(now))
    const [x, y, z] = latLonAltToPosition(
      (geo.latitude * 180) / Math.PI,
      (geo.longitude * 180) / Math.PI,
      geo.height * NEAR_EARTH_ALTITUDE_BOOST,
    )
    groupRef.current.position.set(x * EARTH_RADIUS, y * EARTH_RADIUS, z * EARTH_RADIUS)
  })

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    select(HUBBLE_INFO, groupRef.current, HUBBLE_TARGET_SIZE)
  }

  useRegisterObject({
    key: 'hubble',
    label: 'Hubble',
    category: 'Deep space',
    onSelect: () => select(HUBBLE_INFO, groupRef.current, HUBBLE_TARGET_SIZE),
  })

  if (!ready) return null

  return (
    <group ref={groupRef} onClick={handleClick}>
      <HubbleModel />
      <ClickTarget onClick={handleClick} small />
      <ObjectLabel text="Hubble" radius={HUBBLE_TARGET_SIZE} stackIndex={1} />
    </group>
  )
}

/** Reliable alternative to tapping a (sometimes tiny, sometimes fast-moving)
 * 3D target directly — every registered object, grouped, tap to select and
 * camera-focus exactly as if it had been tapped in the scene. */
function ObjectMenu({ entries }: { entries: RegistryEntry[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? entries.filter((entry) => entry.label.toLowerCase().includes(q)) : entries
  }, [entries, query])

  const grouped = useMemo(() => {
    const map = new Map<string, RegistryEntry[]>()
    for (const entry of filtered) {
      const list = map.get(entry.category) ?? []
      list.push(entry)
      map.set(entry.category, list)
    }
    return map
  }, [filtered])

  return (
    <div className="pointer-events-auto absolute left-4 top-[57px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded border border-white/25 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.08em] shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md ${
          open ? 'bg-white/20 text-white' : 'bg-[#0a0a0d]/90 text-white/70 hover:bg-white/10'
        }`}
      >
        {open ? 'Close' : `Browse (${entries.length})`}
      </button>
      {open ? (
        <div className="mt-1 max-h-[60vh] w-52 overflow-y-auto rounded border border-white/25 bg-[#0a0a0d]/95 p-2 font-mono text-xs text-white/80 shadow-[0_4px_20px_rgba(0,0,0,0.7)] backdrop-blur-md">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="mb-2 w-full rounded border border-white/20 bg-white/5 px-2 py-1 text-white/90 placeholder:text-white/30 focus:outline-none"
          />
          {filtered.length === 0 ? <p className="px-2 py-1 text-white/40">No match</p> : null}
          {[...grouped.entries()].map(([category, items]) => (
            <div key={category} className="mb-2 last:mb-0">
              <p className="mb-1 text-[0.65rem] uppercase tracking-wide text-white/40">{category}</p>
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    item.onSelect()
                    setOpen(false)
                  }}
                  className="block w-full rounded px-2 py-1 text-left hover:bg-white/10"
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// HUD: legend + time-speed control
// ---------------------------------------------------------------------------

/** Collapsed by default — the fully expanded panel ate a large chunk of a
 * phone screen's vertical space. Starts as a single-line pill; tap expands
 * it in place. */
function TypeLegend({
  neoCount,
  trackedCount,
  issTracked,
}: {
  neoCount: number
  trackedCount: number
  issTracked: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  const rows: Array<{ color: string; shape: string; label: string }> = [
    { color: STATUS_HAZARDOUS, shape: 'rounded-full', label: 'asteroid — potentially hazardous' },
    { color: STATUS_SAFE, shape: 'rounded-full', label: 'asteroid — not hazardous' },
    {
      color: TYPE_STATION,
      shape: 'rounded-full',
      label: issTracked ? 'space station — ISS (live)' : 'space station — awaiting fix',
    },
    { color: TYPE_SATELLITE, shape: 'rounded-full', label: 'Starlink constellation — live TLE' },
  ]

  return (
    <div className="pointer-events-auto absolute bottom-[13px] left-4 max-w-[calc(100vw-2rem)] rounded border border-white/25 bg-[#0a0a0d]/90 font-mono text-xs text-white/80 shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span className="text-white/60">
          {neoCount} objects{expanded ? '' : ' · legend'}
        </span>
        <span className="ml-auto text-white/40">{expanded ? '−' : '+'}</span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-1 border-t border-white/15 px-3 pb-2 pt-1.5">
          <p className="text-white/50">{trackedCount} on real heliocentric orbits</p>
          {rows.map((row) => (
            <p key={row.label} className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 ${row.shape}`} style={{ background: row.color }} />
              {row.label}
            </p>
          ))}
          <p className="text-white/40">Tap an object for details &amp; focus</p>
        </div>
      ) : null}
    </div>
  )
}

type SpeedMode = 'realtime' | 'accelerated' | 'fast'

const SPEED_MODES: Record<SpeedMode, { label: string; daysPerSecond: number }> = {
  realtime: { label: 'Real-time', daysPerSecond: REALTIME_DAYS_PER_SECOND },
  accelerated: { label: '3 d/s', daysPerSecond: ACCELERATED_DAYS_PER_SECOND },
  fast: { label: '45 d/s', daysPerSecond: FAST_DAYS_PER_SECOND },
}

function SatelliteToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`pointer-events-auto absolute right-4 top-[57px] rounded border border-white/25 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.08em] shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md ${
        visible ? 'bg-white/20 text-white' : 'bg-[#0a0a0d]/90 text-white/70 hover:bg-white/10'
      }`}
    >
      {visible ? 'Hide satellites' : 'Show satellites'}
    </button>
  )
}

type UpcomingApproach = {
  name: string
  date: string
  missDistanceKm: number
  isPotentiallyHazardous: boolean
}

function formatApproachDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** One real, already-fetched-elsewhere NASA stat surfaced as a small always-
 * on hook — the closest tracked approach in the coming week, updated once
 * per mount. Compact by design (see the legend's own space complaint on
 * mobile): a single line, no expand state, nothing to manage. */
function NextApproachTicker() {
  const [approach, setApproach] = useState<UpcomingApproach | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/next-approach')
      .then((res) => res.json())
      .then((data: { approach: UpcomingApproach | null }) => {
        if (!cancelled) setApproach(data.approach)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!approach) return null

  const millionKm = (approach.missDistanceKm / 1_000_000).toFixed(1)
  const color = approach.isPotentiallyHazardous ? STATUS_HAZARDOUS : STATUS_SAFE

  // Stacked above the legend pill at the bottom-left, not top-left — the
  // Sun auto-selects on mount, so the info panel is up there by default and
  // a top-anchored ticker either got cut off under it or had to fight it
  // for width on a phone screen. Collapsed by default like the legend, for
  // the same reason.
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="pointer-events-auto absolute bottom-[53px] left-4 flex max-w-[80vw] items-center gap-1.5 rounded border border-white/25 bg-[#0a0a0d]/90 px-3 py-2 text-left font-mono text-[0.65rem] text-white/70 shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md"
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      {expanded ? (
        <span className="truncate">
          {approach.name} · {millionKm}M km · {formatApproachDate(approach.date)}
        </span>
      ) : (
        <span>{millionKm}M km this week</span>
      )}
    </button>
  )
}

/** Jumps the simulation clock straight to a picked date instead of only
 * scrubbing forward at a speed multiplier — clockRef is the same plain
 * mutable box SimulationClockProvider reads every frame, so setting
 * .current here is all a "time travel" jump needs, no extra state/context. */
/** Applies a shared deep link's `?t=` julian date to the clock on mount —
 * split out from EarthScene itself because clockRef there is a plain
 * parameter (not the useMemo binding directly), which is what a mutation
 * like this needs. */
function ShareLinkRestore({
  clockRef,
  pendingObjRef,
}: {
  clockRef: ClockRef
  pendingObjRef: React.RefObject<string | null>
}) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('t')
    if (t) {
      const julianDate = Number(t)
      if (Number.isFinite(julianDate)) clockRef.current = julianDate
    }
    pendingObjRef.current = params.get('obj')
  }, [clockRef, pendingObjRef])
  return null
}

function TimeTravelControl({ clockRef }: { clockRef: ClockRef }) {
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.value) return
    clockRef.current = unixMsToJulianDate(new Date(`${event.target.value}T00:00:00Z`).getTime())
  }

  return (
    <div className="pointer-events-auto absolute bottom-[53px] right-4 flex items-center gap-2 rounded border border-white/25 bg-[#0a0a0d]/90 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.08em] text-white/70 shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md">
      <input
        type="date"
        onChange={handleChange}
        className="w-[7.5rem] bg-transparent normal-case tracking-normal text-white/90 [color-scheme:dark] focus:outline-none"
      />
      <button
        type="button"
        onClick={() => {
          clockRef.current = unixMsToJulianDate(Date.now())
        }}
        className="shrink-0 hover:text-white"
      >
        Now
      </button>
    </div>
  )
}

function TimeControl({ speedRef }: { speedRef: SpeedRef }) {
  const [mode, setMode] = useState<SpeedMode>('realtime')

  return (
    <div className="pointer-events-auto absolute bottom-[13px] right-4 flex gap-1 rounded border border-white/25 bg-[#0a0a0d]/90 font-mono text-[0.65rem] uppercase tracking-[0.08em] text-white/70 shadow-[0_2px_12px_rgba(0,0,0,0.5)] backdrop-blur-md">
      {(Object.keys(SPEED_MODES) as SpeedMode[]).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => {
            setMode(key)
            speedRef.current = SPEED_MODES[key].daysPerSecond
          }}
          className={`px-3 py-2 ${mode === key ? 'bg-white/20 text-white' : 'hover:bg-white/10'}`}
        >
          {SPEED_MODES[key].label}
        </button>
      ))}
    </div>
  )
}

// drei's <Stars> places every star in a shell fixed to the scene ORIGIN
// (radius..radius+depth from (0,0,0)). That's fine while the camera orbits
// near the origin, but OrbitControls' target — and so the camera — can end
// up anywhere once a distant object is selected (e.g. an outer planet),
// which can push the camera outside the fixed shell entirely: stars behind
// it disappear, which is exactly the "invisible when zoomed/panned out"
// symptom reported. Recentering the whole starfield on the camera every
// frame (a standard skybox trick) makes it origin-independent: stars are
// always at the same *relative* distance from the viewer, so they're always
// visible regardless of where the current orbit target is.
const STARFIELD_RADIUS = 60
const STARFIELD_DEPTH = 40

function CameraCenteredStars() {
  const groupRef = useRef<Group>(null)

  useFrame((state) => {
    groupRef.current?.position.copy(state.camera.position)
  })

  return (
    <group ref={groupRef}>
      <Stars radius={STARFIELD_RADIUS} depth={STARFIELD_DEPTH} count={3000} factor={3} />
    </group>
  )
}

export function EarthScene() {
  const [objects, setObjects] = useState<NearEarthObject[]>([])
  const [issTracked, setIssTracked] = useState(false)
  const [showSatellites, setShowSatellites] = useState(true)
  const [selected, setSelected] = useState<SelectedInfo | null>(null)
  const [focusTarget, setFocusTarget] = useState<Object3D | null>(null)
  // Drives OrbitControls' minDistance below — a single fixed 0.7 floor
  // worked fine for planets but made it physically impossible to zoom close
  // enough to small objects (comets, ISS, Hubble) to ever clear their own
  // label-hide threshold, since that floor was bigger than the threshold.
  const [focusRadius, setFocusRadius] = useState(DEFAULT_MIN_ZOOM_DISTANCE)
  const [menuEntries, setMenuEntries] = useState<RegistryEntry[]>([])
  // A plain mutable box, not a React ref — the time-speed toggle mutates it
  // directly and useFrame callbacks read it every frame; it never drives
  // this component's own render output.
  const speedBox = useMemo<SpeedRef>(() => ({ current: REALTIME_DAYS_PER_SECOND }), [])
  const clockBox = useMemo<ClockRef>(() => ({ current: BASE_JULIAN_DATE }), [])
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const [webglSupported, setWebglSupported] = useState(true)

  useEffect(() => {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    queueMicrotask(() => setWebglSupported(Boolean(gl)))
  }, [])

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

  const select = useCallback(
    (info: SelectedInfo, target?: Object3D | null, radius?: number) => {
      setSelected(info)
      setFocusTarget(target ?? null)
      setFocusRadius(
        radius ? Math.max(MIN_ZOOM_DISTANCE_FLOOR, radius * MIN_ZOOM_DISTANCE_FACTOR) : DEFAULT_MIN_ZOOM_DISTANCE,
      )
      navigator.vibrate?.(10)
      // Shareable deep link — the object's own title doubles as its lookup
      // key (every SelectedInfo already carries one, so this needs no extra
      // id threaded through the ~15 call sites that call select()), plus the
      // raw simulation Julian date so a shared link reproduces the same view.
      const params = new URLSearchParams(window.location.search)
      params.set('obj', info.title)
      params.set('t', clockBox.current.toFixed(4))
      window.history.replaceState(null, '', `?${params.toString()}`)
    },
    [clockBox],
  )

  // Restores a shared deep link on load: the object selection waits for the
  // registry to populate (useRegisterObject calls land in effects after
  // mount) and fires once via pendingShareObjRef, set by <ShareLinkRestore>.
  const pendingShareObjRef = useRef<string | null>(null)
  useEffect(() => {
    if (!pendingShareObjRef.current) return
    const entry = menuEntries.find((e) => e.label === pendingShareObjRef.current)
    if (!entry) return
    pendingShareObjRef.current = null
    entry.onSelect()
  }, [menuEntries])

  const trackedObjects = objects.filter((neo) => neo.orbit !== null)
  const fallbackObjects = objects.filter((neo) => neo.orbit === null)

  if (!webglSupported) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-black px-6 text-center font-mono text-white/70">
        <p className="text-sm text-white/90">WebGL unavailable</p>
        <p className="max-w-xs text-xs">
          This browser or device can&apos;t render 3D graphics. Try a recent Chrome, Firefox, or Safari with
          hardware acceleration enabled.
        </p>
      </div>
    )
  }

  return (
    <SelectionContext.Provider value={select}>
      <RegistryProvider onEntriesChange={setMenuEntries}>
      <div className="relative h-full w-full">
        <Canvas
          camera={{ position: [3, 2, 9], fov: 45, near: 0.01, far: 200 }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          // Capped below the usual [1,2] — fragment cost (day/night shader,
          // atmosphere/sun-glow additive passes) scales with dpr², so 2x on a
          // 3x-DPR phone was ~78% more fill-rate than 1.5x for a sharpness
          // difference nobody's going to see on a phone screen.
          dpr={[1, 1.5]}
          onPointerMissed={() => {
            setSelected(null)
            setFocusTarget(null)
            setFocusRadius(DEFAULT_MIN_ZOOM_DISTANCE)
          }}
        >
          <SimulationClockProvider speedRef={speedBox} clockRef={clockBox}>
            {/* SunLight is the only light in the scene — no ambient fill. */}
            <SunLight />
            <Earth />
            <MoonOrbitRing />
            <Moon />
            <HeliocentricFrame>
              <Sun />
              <InnerSolarSystem />
              <CometField />
              <VoyagerField />
              <DwarfPlanetField />
              <NamedAsteroidField />
              <Jwst />
              <HelioNeoField objects={trackedObjects} />
            </HeliocentricFrame>
            <FallbackNeoField objects={fallbackObjects} />
            <IssTracker onFix={() => setIssTracked(true)} />
            <Hubble />
            <SatelliteConstellation visible={showSatellites} />
            <CameraFocus target={focusTarget} controlsRef={controlsRef} />
          </SimulationClockProvider>
          <CameraCenteredStars />
          <OrbitControls ref={controlsRef} enablePan minDistance={focusRadius} maxDistance={60} />
        </Canvas>
        <ObjectMenu entries={menuEntries} />
        <TypeLegend neoCount={objects.length} trackedCount={trackedObjects.length} issTracked={issTracked} />
        <NextApproachTicker />
        <SatelliteToggle visible={showSatellites} onToggle={() => setShowSatellites((v) => !v)} />
        <ShareLinkRestore clockRef={clockBox} pendingObjRef={pendingShareObjRef} />
        <TimeTravelControl clockRef={clockBox} />
        <TimeControl speedRef={speedBox} />
        {selected ? (
          <InfoPanel
            info={selected}
            onClose={() => {
              setSelected(null)
              setFocusTarget(null)
              setFocusRadius(DEFAULT_MIN_ZOOM_DISTANCE)
            }}
          />
        ) : null}
      </div>
      </RegistryProvider>
    </SelectionContext.Provider>
  )
}
