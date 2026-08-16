import { ImageResponse } from 'next/og'

export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#05060a',
          color: 'white',
          fontFamily: 'monospace',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: 140,
            height: 140,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 35%, #6fa8ff, #0a2a6b 70%)',
            boxShadow: '0 0 80px 10px rgba(111,168,255,0.5)',
            marginBottom: 40,
          }}
        />
        <div style={{ display: 'flex', fontSize: 64, fontWeight: 700, letterSpacing: -1 }}>
          Near Earth Visualizer
        </div>
        <div style={{ display: 'flex', fontSize: 28, color: 'rgba(255,255,255,0.6)', marginTop: 16 }}>
          Real-time WebGL solar system — live NASA orbital data
        </div>
      </div>
    ),
    { ...size },
  )
}
