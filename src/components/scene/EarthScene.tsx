'use client'

import { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Stars, useTexture } from '@react-three/drei'
import type { Mesh } from 'three'
import type { NearEarthObject } from '@/lib/nasa'
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

function Earth() {
  const meshRef = useRef<Mesh>(null)
  const dayMap = useTexture('/textures/2k_earth_daymap.jpg')

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.05
    }
  })

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 64, 64]} />
      <meshStandardMaterial map={dayMap} roughness={0.9} metalness={0.03} />
    </mesh>
  )
}

/** Deterministic pseudo-orbit placement, not real orbital mechanics (that's NEC-05). */
function schematicPosition(neo: NearEarthObject, index: number): [number, number, number] {
  let hash = 0
  for (let i = 0; i < neo.id.length; i += 1) {
    hash = (hash * 31 + neo.id.charCodeAt(i)) >>> 0
  }
  const theta = ((hash % 360) / 360) * Math.PI * 2
  const phi = (((hash >> 8) % 180) / 180) * Math.PI - Math.PI / 2

  // Log-scale the (huge, widely-varying) miss distance into a readable shell radius.
  const distanceShell = Math.min(
    6,
    1.8 + Math.log10(Math.max(neo.missDistanceKm, 1e5)) * 0.35 + index * 0.01,
  )

  return [
    distanceShell * Math.cos(phi) * Math.cos(theta),
    distanceShell * Math.sin(phi),
    distanceShell * Math.cos(phi) * Math.sin(theta),
  ]
}

function NeoMarker({ neo, position }: { neo: NearEarthObject; position: [number, number, number] }) {
  // Clamp so a 30m rock and a 1km rock both stay legible on screen.
  const radius = Math.min(0.12, Math.max(0.02, neo.estimatedDiameterKm * 0.05))
  const color = neo.isPotentiallyHazardous ? STATUS_HAZARDOUS : STATUS_SAFE

  return (
    <mesh position={position}>
      <sphereGeometry args={[radius, 12, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
    </mesh>
  )
}

function NeoField({ objects }: { objects: NearEarthObject[] }) {
  return (
    <group>
      {objects.map((neo, index) => (
        <NeoMarker key={neo.id} neo={neo} position={schematicPosition(neo, index)} />
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

function TypeLegend({ neoCount, issTracked }: { neoCount: number; issTracked: boolean }) {
  const rows: Array<{ color: string; shape: string; label: string }> = [
    { color: STATUS_HAZARDOUS, shape: 'rounded-full', label: 'asteroid — potentially hazardous' },
    { color: STATUS_SAFE, shape: 'rounded-full', label: 'asteroid — not hazardous' },
    {
      color: TYPE_STATION,
      shape: 'rounded-full',
      label: issTracked ? 'space station — ISS (live)' : 'space station — awaiting fix',
    },
    { color: TYPE_SATELLITE, shape: 'rounded-full', label: 'satellite — tracking pending (NEC-05)' },
    { color: TYPE_SHUTTLE, shape: 'rounded-full', label: 'shuttle — tracking pending (NEC-05)' },
  ]

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1 rounded border border-white/15 bg-black/60 px-3 py-2 font-mono text-xs text-white/80 backdrop-blur-sm">
      <p className="text-white/50">{neoCount} near-Earth objects today</p>
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

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [0, 0, 3], fov: 45 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 3, 5]} intensity={1.6} />
        <Earth />
        <NeoField objects={objects} />
        <IssTracker onFix={() => setIssTracked(true)} />
        <Stars radius={80} depth={40} count={3000} factor={3} fade />
        <OrbitControls enablePan={false} minDistance={1.5} maxDistance={8} />
      </Canvas>
      <TypeLegend neoCount={objects.length} issTracked={issTracked} />
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
