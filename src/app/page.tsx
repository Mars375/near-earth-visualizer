import { EarthScene } from '@/components/scene/EarthScene'
import { ViewportFrame } from '@/components/hud/ViewportFrame'

export default function Home() {
  return (
    <main className="h-dvh w-dvw bg-black">
      <ViewportFrame>
        <EarthScene />
      </ViewportFrame>
    </main>
  )
}
