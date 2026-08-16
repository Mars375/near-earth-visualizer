import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const WIDTH = 2048
const HEIGHT = 1024
const FALLBACK_TEXTURE_PATH = path.join(process.cwd(), 'public', 'textures', '2k_earth_daymap.jpg')

// A true-color daytime mosaic never legitimately contains near-black pixels
// (ocean, land, and cloud all reflect some light) — this threshold catches
// missing-tile gaps, not real darkness, since polar night wouldn't appear in
// a "daytime" composite layer in the first place.
const NO_DATA_THRESHOLD = 12

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Proxies NASA GIBS's real daily VIIRS true-color satellite mosaic as the
 * Earth day-map texture — actual weather, not a static generic cloud
 * texture. Defaults to yesterday (UTC): today's mosaic is still filling in.
 *
 * GIBS' polar coverage for this layer is unreliable: it regularly leaves a
 * solid black band of missing tiles near the poles (confirmed by inspecting
 * the raw fetched image — it's a hard-edged rectangular band at a fixed
 * latitude, not the organic shape a real terminator/night side would have).
 * That was read as a rendering bug ("dark patch under Earth") when it was
 * actually a data gap. Fixed by masking near-black pixels out of the GIBS
 * image and compositing the gap-free static fallback underneath, so missing
 * tiles show real (if not live) imagery instead of a black hole.
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
    const gibsBuffer = Buffer.from(await response.arrayBuffer())
    const { data, info } = await sharp(gibsBuffer)
      .resize(WIDTH, HEIGHT)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < NO_DATA_THRESHOLD && data[i + 1] < NO_DATA_THRESHOLD && data[i + 2] < NO_DATA_THRESHOLD) {
        data[i + 3] = 0
      }
    }

    const maskedGibsPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer()
    const fallbackBuffer = await readFile(FALLBACK_TEXTURE_PATH)

    const composite = await sharp(fallbackBuffer)
      .resize(WIDTH, HEIGHT)
      .composite([{ input: maskedGibsPng }])
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
