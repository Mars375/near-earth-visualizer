import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const WIDTH = 2048
const HEIGHT = 1024
const FALLBACK_TEXTURE_PATH = path.join(process.cwd(), 'public', 'textures', '2k_earth_daymap.jpg')

// GIBS' VIIRS true-color layer regularly leaves a solid black band of
// missing tiles near the poles (confirmed by inspecting the raw fetched
// image — a hard-edged rectangular gap, not the organic shape a real
// terminator would have), and the exact gap size varies by date. A first
// attempt masked out near-black pixels and composited the static fallback
// underneath, but a content-based mask still has a hard (if slightly
// blurred) edge exactly where that day's gap happens to end, and the two
// sources don't color-match — it read as an obvious seam/sticker, not an
// improvement worth keeping.
//
// This instead ALWAYS fades GIBS out over a fixed band near each pole,
// regardless of whether that day's gap is smaller or absent — a wide,
// deliberate gradient blend into the gap-free static fallback. Poles are
// visually just ice/cloud anyway, so losing live detail there costs little,
// and the blend location no longer depends on content that changes daily.
//
// Measured the real gap across the full image width: consistently ~163-168px
// deep at the south pole (a symmetric first attempt with a single ~164px
// fade radius still let the gap's solid black bleed through at ~80%+ alpha
// well before its own edge — the gap has no gradient of its own, so ANY
// nonzero alpha inside it shows black). Alpha must stay exactly 0 for the
// gap's full known depth, and only start rising past it — hence two zones:
// a flat dead-zone, then a ramp entirely beyond the measured gap.
const POLE_DEAD_ZONE_ROWS = 200 // alpha stays 0 through here — beyond the ~168px measured gap
const POLE_RAMP_ROWS = 120 // then eases 0 -> 255 over this many additional rows

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/** Precomputed once at module load — this mask never depends on the fetched
 * image's content, only on row position, so it's the same every request. */
function buildPoleFadeMask(): Buffer {
  const mask = Buffer.alloc(WIDTH * HEIGHT)
  for (let y = 0; y < HEIGHT; y += 1) {
    const distanceFromPole = Math.min(y, HEIGHT - 1 - y)
    const rampProgress = (distanceFromPole - POLE_DEAD_ZONE_ROWS) / POLE_RAMP_ROWS
    const alpha = Math.round(255 * smoothstep(rampProgress))
    mask.fill(alpha, y * WIDTH, (y + 1) * WIDTH)
  }
  return mask
}

const POLE_FADE_MASK = buildPoleFadeMask()

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Proxies NASA GIBS's real daily VIIRS true-color satellite mosaic as the
 * Earth day-map texture — actual weather, not a static generic cloud
 * texture. Defaults to yesterday (UTC): today's mosaic is still filling in.
 * Composites the gap-free static fallback underneath a fixed polar fade
 * (see POLE_FADE_FRACTION above) so GIBS' unreliable pole coverage never
 * shows through as a black hole or a hard seam.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get('date') ?? yesterdayUtc()

  const params = new URLSearchParams({
    version: '1.3.0',
    service: 'WMS',
    request: 'GetMap',
    format: 'image/jpeg',
    STYLE: 'default',
    bbox: '-90,-180,90,180',
    CRS: 'EPSG:4326',
    HEIGHT: String(HEIGHT),
    WIDTH: String(WIDTH),
    TIME: date,
    layers: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
  })

  const response = await fetch(`${GIBS_WMS}?${params.toString()}`, { cache: 'no-store' })

  if (!response.ok) {
    // GIBS unreachable — fall back to the static local texture rather than
    // erroring the whole Earth mesh out.
    return Response.redirect(new URL('/textures/2k_earth_daymap.jpg', request.url), 307)
  }

  try {
    const gibsRgb = await sharp(Buffer.from(await response.arrayBuffer()))
      .resize(WIDTH, HEIGHT)
      .removeAlpha()
      .raw()
      .toBuffer()

    const gibsWithPoleFade = await sharp(gibsRgb, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
      .joinChannel(POLE_FADE_MASK, { raw: { width: WIDTH, height: HEIGHT, channels: 1 } })
      .png()
      .toBuffer()

    const fallbackBuffer = await readFile(FALLBACK_TEXTURE_PATH)

    const composite = await sharp(fallbackBuffer)
      .resize(WIDTH, HEIGHT)
      .composite([{ input: gibsWithPoleFade }])
      .jpeg({ quality: 88 })
      .toBuffer()

    return new Response(composite, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=21600',
      },
    })
  } catch {
    return Response.redirect(new URL('/textures/2k_earth_daymap.jpg', request.url), 307)
  }
}
