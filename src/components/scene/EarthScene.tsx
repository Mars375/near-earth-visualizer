'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Stars, useTexture } from '@react-three/drei'
import { AdditiveBlending, BackSide, Vector3, type Mesh } from 'three'
import type { NearEarthObject } from '@/lib/nasa'
import {
  earthHeliocentricPosition,
  heliocentricPosition,
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

// Real Sun direction at load time (Earth's actual heliocentric position right
// now), not an arbitrary artistic angle. Kept fixed for the day/night
// terminator's whole session — only the rendered Sun mesh (see <Sun/>) moves
// with simulated time, so the two can drift apart slowly over a long session.
// That's an accepted approximation, not a bug.
const initialEarthPos = earthHeliocentricPosition(BASE_JULIAN_DATE)
const SUN_DIRECTION = new Vector3(
  -initialEarthPos.x,
  -initialEarthPos.y,
  -initialEarthPos.z,
).normalize()

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
  // Real daily satellite mosaic (NASA GIBS) instead of a static generic map.
  const [dayMap, nightMap] = useTexture([
    '/api/earth-imagery',
    '/textures/2k_earth_nightmap.jpg',
  ])

  const uniforms = useMemo(
    () => ({
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      sunDirection: { value: SUN_DIRECTION },
    }),
    [dayMap, nightMap],
  )

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.05
    }
  })

  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry args={[1, 64, 64]} />
        <shaderMaterial
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

/** The Sun, positioned from Earth's real (simulated-time) heliocentric
 * position — not a static prop. Size is artistic (a real-scale Sun at
 * AU_SCALE would be ~109x Earth's radius and swallow the scene); distance
 * is the real relative scale, same AU_SCALE as the asteroid orbits. */
function Sun() {
  const meshRef = useRef<Mesh>(null)

  useFrame((state) => {
    if (!meshRef.current) return
    const jd = simulatedJulianDate(state.clock.elapsedTime)
    const earthPos = earthHeliocentricPosition(jd)
    meshRef.current.position.set(
      -earthPos.x * AU_SCALE,
      -earthPos.y * AU_SCALE,
      -earthPos.z * AU_SCALE,
    )
  })

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[0.65, 32, 32]} />
      <meshBasicMaterial color="#fff2c8" />
    </mesh>
  )
}

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
  const radius = Math.min(
    6,
    1.8 + Math.log10(Math.max(neo.missDistanceKm, 1e5)) * 0.35 + index * 0.01,
  )
  const angularSpeed = Math.min(0.18, 0.02 + neo.relativeVelocityKmS * 0.004)
  return { radius, phi, theta0, angularSpeed }
}

function NeoMarker({ neo, index }: { neo: NearEarthObject; index: number }) {
  const meshRef = useRef<Mesh>(null)
  // Clamp so a 30m rock and a 1km rock both stay legible on screen.
  const radius = Math.min(0.12, Math.max(0.02, neo.estimatedDiameterKm * 0.05))
  const color = neo.isPotentiallyHazardous ? STATUS_HAZARDOUS : STATUS_SAFE
  const orbit = neo.orbit
  const fallback = useMemo(() => fallbackOrbit(neo, index), [neo, index])

  useFrame((state) => {
    if (!meshRef.current) return

    if (orbit) {
      const jd = simulatedJulianDate(state.clock.elapsedTime)
      const asteroidPos = heliocentricPosition(orbit as OrbitalElements, jd)
      const earthPos = earthHeliocentricPosition(jd)
      const relative = subtract(asteroidPos, earthPos)
      meshRef.current.position.set(
        relative.x * AU_SCALE,
        relative.y * AU_SCALE,
        relative.z * AU_SCALE,
      )
    } else {
      const theta = fallback.theta0 + state.clock.elapsedTime * fallback.angularSpeed
      meshRef.current.position.set(
        fallback.radius * Math.cos(fallback.phi) * Math.cos(theta),
        fallback.radius * Math.sin(fallback.phi),
        fallback.radius * Math.cos(fallback.phi) * Math.sin(theta),
      )
    }
  })

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[radius, 12, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
    </mesh>
  )
}

function NeoField({ objects }: { objects: NearEarthObject[] }) {
  return (
    <group>
      {objects.map((neo, index) => (
        <NeoMarker key={neo.id} neo={neo} index={index} />
      ))}
    </group>
  )
}

/** Torus silhouette reads as a station's ring/truss structure at marker scale. */
function StationMarker({ position }: { position: [number, number, number] }) {
  const ref = useRef<Mesh>(null)
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.z += delta * 0.3
  })

  return (
    <mesh ref={ref} position={position}>
      <torusGeometry args={[0.05, 0.012, 8, 16]} />
      <meshStandardMaterial
        color={TYPE_STATION}
        emissive={TYPE_STATION}
        emissiveIntensity={0.5}
      />
    </mesh>
  )
}

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
    </div>
  )
}

export function EarthScene() {
  const [objects, setObjects] = useState<NearEarthObject[]>([])
  const [issTracked, setIssTracked] = useState(false)

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

  const trackedCount = objects.filter((neo) => neo.orbit !== null).length

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [0, 0, 3], fov: 45 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.25} />
        <directionalLight position={SUN_DIRECTION} intensity={1.6} />
        <Sun />
        <Earth />
        <NeoField objects={objects} />
        <IssTracker onFix={() => setIssTracked(true)} />
        <Stars radius={80} depth={40} count={3000} factor={3} fade />
        <OrbitControls enablePan={false} minDistance={1.5} maxDistance={12} />
      </Canvas>
      <TypeLegend neoCount={objects.length} trackedCount={trackedCount} issTracked={issTracked} />
    </div>
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
  return <StationMarker position={position} />
}
