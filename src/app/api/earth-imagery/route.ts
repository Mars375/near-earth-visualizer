import sharp from 'sharp'

const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const WIDTH = 2048
const HEIGHT = 1024

// GIBS' VIIRS true-color layer excludes any pixel without enough sunlight
// for a valid reflectance reading — in southern winter that blanks out a
// large chunk of the far south (measured ~163-168px deep, consistently
// across the full image width) as solid black, not a gradual dimming.
//
// Two earlier attempts composited the gap-free static fallback texture
// underneath: first with a content-based mask (hard seam where that day's
// gap happened to end), then with a fixed positional fade (still a visible
// band — the fallback's clear-sky ocean and GIBS' hazy cloud-heavy edge are
// just different-looking sources; no amount of feathering the alpha between
// them fully hides that mismatch).
//
// This instead never brings in a second source at all: it stretches GIBS'
// own last valid row at each pole down to cover the gap, then blurs that
// stretched fill. Color continuity at the boundary is exact by construction
// (the fill starts as a copy of the real neighboring pixels), so there's no
// seam to hide — just a soft, self-similar haze toward the pole.
const SOUTH_GAP_ROWS = 185 // ~15px margin past the measured ~168px gap
const NORTH_GAP_ROWS = 40 // measured north-side gaps were only ~0-16px
const FILL_BLUR_SIGMA = 60

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Stretches a single boundary row into a `rows`-tall strip and blurs it —
 * a self-similar "haze" fill that's color-continuous with its own source
 * image at the seam, used to cover a pole's data gap without introducing a
 * second, differently-styled image. */
async function buildPoleFill(gibsRgb: Buffer, boundaryY: number, rows: number): Promise<Buffer> {
  return sharp(gibsRgb, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .extract({ left: 0, top: boundaryY, width: WIDTH, height: 1 })
    .resize(WIDTH, rows, { fit: 'fill' })
    .blur(FILL_BLUR_SIGMA)
    .toColourspace('srgb')
    .raw()
    .toBuffer()
}

/**
 * Proxies NASA GIBS's real daily VIIRS true-color satellite mosaic as the
 * Earth day-map texture — actual weather, not a static generic cloud
 * texture. Defaults to yesterday (UTC): today's mosaic is still filling in.
 * Self-fills each pole's data gap (see comment above) rather than
 * compositing in a different, differently-colored source there.
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

    const southBoundaryY = HEIGHT - 1 - SOUTH_GAP_ROWS
    const northBoundaryY = NORTH_GAP_ROWS

    const [southFill, northFill] = await Promise.all([
      buildPoleFill(gibsRgb, southBoundaryY, SOUTH_GAP_ROWS + 1),
      buildPoleFill(gibsRgb, northBoundaryY, NORTH_GAP_ROWS + 1),
    ])

    const composite = await sharp(gibsRgb, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
      .composite([
        {
          input: southFill,
          raw: { width: WIDTH, height: SOUTH_GAP_ROWS + 1, channels: 3 },
          left: 0,
          top: southBoundaryY,
        },
        {
          input: northFill,
          raw: { width: WIDTH, height: NORTH_GAP_ROWS + 1, channels: 3 },
          left: 0,
          top: 0,
        },
      ])
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
