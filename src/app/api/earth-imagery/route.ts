const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Proxies NASA GIBS's real daily VIIRS true-color satellite mosaic as the
 * Earth day-map texture — actual weather, not a static generic cloud
 * texture. Defaults to yesterday (UTC): today's mosaic is still filling in
 * as satellite passes accumulate through the day and has visible gaps.
 * High-latitude winter darkness renders as black — that's real polar
 * night, not a data gap.
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
    HEIGHT: '1024',
    WIDTH: '2048',
    TIME: date,
    layers: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
  })

  const response = await fetch(`${GIBS_WMS}?${params.toString()}`, {
    next: { revalidate: 21600 },
  })

  if (!response.ok || !response.body) {
    // GIBS unreachable — fall back to the static local texture rather than
    // erroring the whole Earth mesh out.
    return Response.redirect(new URL('/textures/2k_earth_daymap.jpg', request.url), 307)
  }

  return new Response(response.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=21600',
    },
  })
}
