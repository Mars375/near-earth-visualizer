'use client'

import { useEffect, useState } from 'react'

const BRACKET_POSITIONS = [
  'left-3 top-3 border-l border-t',
  'right-3 top-3 border-r border-t',
  'left-3 bottom-3 border-l border-b',
  'right-3 bottom-3 border-r border-b',
] as const

function CornerBrackets() {
  return (
    <>
      {BRACKET_POSITIONS.map((position) => (
        <div
          key={position}
          aria-hidden="true"
          className={`pointer-events-none absolute h-6 w-6 border-white/30 ${position}`}
        />
      ))}
    </>
  )
}

function UtcClock() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(interval)
  }, [])

  if (!now) return <span className="tabular-nums">--:--:--</span>

  return (
    <span className="tabular-nums">
      {now.toISOString().slice(11, 19)} UTC
    </span>
  )
}

export function ViewportFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-full w-full">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-white/15 bg-black/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.16em] text-white/70 backdrop-blur-sm">
        <span>Near Earth Visualizer</span>
        <UtcClock />
      </div>
      <CornerBrackets />
      {children}
    </div>
  )
}
