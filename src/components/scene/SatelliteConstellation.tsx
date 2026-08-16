'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import type { BufferAttribute, Points } from 'three'
import { gstime, propagate, twoline2satrec, eciToGeodetic, type SatRec } from 'satellite.js'
import { latLonAltToPosition } from '@/lib/spaceObjects'
import type { TleEntry } from '@/app/api/satellites/route'

const EARTH_RADIUS = 0.5
const SATELLITE_COLOR = '#3987e5' // same blue as TYPE_SATELLITE in EarthScene's legend

// Propagating every satellite every frame would spike CPU for a field this
// size. Instead a rolling cursor re-propagates a slice each frame, cycling
// through the whole set continuously — each dot still refreshes several
// times a second, smooth enough for orbital motion, at a fraction of the cost.
const CHUNK_SIZE = 150

/**
 * Real Starlink constellation, positioned from live-fetched Celestrak TLEs
 * and propagated with satellite.js's SGP4 implementation — actual orbital
 * state, not schematic placement. Deliberately anchored to real wall-clock
 * time (not the app's adjustable simulation clock): TLEs are epoch-relative
 * to real UTC, so fast-forwarding or rewinding the sim clock would propagate
 * them nonsensically far from their valid window.
 */
export function SatelliteConstellation({ visible }: { visible: boolean }) {
  const pointsRef = useRef<Points>(null)
  const cursorRef = useRef(0)
  const [satrecs, setSatrecs] = useState<SatRec[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/satellites')
      .then((res) => res.json())
      .then((data: { satellites?: TleEntry[] }) => {
        if (cancelled) return
        const parsed = (data.satellites ?? []).map((entry) => twoline2satrec(entry.line1, entry.line2))
        setSatrecs(parsed)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Only used to seed the buffer's initial size on (re)mount — per-frame
  // updates below write directly into the mounted geometry's own array
  // (a Three.js object reached through the ref), never back into this value.
  const initialPositions = useMemo(() => new Float32Array(satrecs.length * 3), [satrecs])

  useEffect(() => {
    if (pointsRef.current) pointsRef.current.visible = visible
  }, [visible])

  useFrame(() => {
    if (!visible || satrecs.length === 0 || !pointsRef.current) return

    const now = new Date()
    const gmst = gstime(now)
    const attribute = pointsRef.current.geometry.attributes.position as BufferAttribute
    const array = attribute.array as Float32Array

    const start = cursorRef.current
    const end = Math.min(start + CHUNK_SIZE, satrecs.length)
    for (let i = start; i < end; i += 1) {
      const result = propagate(satrecs[i], now)
      if (!result || !result.position) continue
      const geo = eciToGeodetic(result.position, gmst)
      const latDeg = (geo.latitude * 180) / Math.PI
      const lonDeg = (geo.longitude * 180) / Math.PI
      const [x, y, z] = latLonAltToPosition(latDeg, lonDeg, geo.height)
      array[i * 3] = x * EARTH_RADIUS
      array[i * 3 + 1] = y * EARTH_RADIUS
      array[i * 3 + 2] = z * EARTH_RADIUS
    }
    cursorRef.current = end >= satrecs.length ? 0 : end
    attribute.needsUpdate = true
  })

  if (satrecs.length === 0) return null

  return (
    <points ref={pointsRef} visible={visible}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[initialPositions, 3]} />
      </bufferGeometry>
      <pointsMaterial color={SATELLITE_COLOR} size={0.012} sizeAttenuation transparent opacity={0.85} />
    </points>
  )
}
