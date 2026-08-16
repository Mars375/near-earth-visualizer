import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Near Earth Visualizer',
    short_name: 'NEO Viz',
    description: 'Real-time WebGL solar system — live NASA orbital data, ISS, Starlink, and near-Earth objects.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#05060a',
    theme_color: '#05060a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
