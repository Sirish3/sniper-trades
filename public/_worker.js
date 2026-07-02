// Cloudflare Pages Advanced Mode worker.
// Handles API proxy routes, falls through to static assets for everything else.
// Avoids the functions/ directory which triggers Cloudflare's Vite version check.

const PROXIES = [
  { prefix: '/alpaca-data', target: 'https://data.alpaca.markets' },
  { prefix: '/alpaca',      target: 'https://paper-api.alpaca.markets' },
  { prefix: '/finnhub',     target: 'https://finnhub.io' },
  { prefix: '/wikipedia',   target: 'https://en.wikipedia.org' },
]

async function handleProxy(request, target, prefix) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      },
    })
  }

  const url = new URL(request.url)
  const upstreamUrl = `${target}${url.pathname.slice(prefix.length)}${url.search}`

  const headers = new Headers()
  // Forward Alpaca auth headers if present
  if (request.headers.get('APCA-API-KEY-ID')) {
    headers.set('APCA-API-KEY-ID', request.headers.get('APCA-API-KEY-ID'))
    headers.set('APCA-API-SECRET-KEY', request.headers.get('APCA-API-SECRET-KEY') || '')
  }
  headers.set('Accept', 'application/json')
  // Wikipedia requires a descriptive User-Agent
  if (prefix === '/wikipedia') {
    headers.set('User-Agent', 'sniper-trades/1.0 (stockpilot.cc)')
  }

  try {
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    })

    const body = await response.arrayBuffer()
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname

    for (const { prefix, target } of PROXIES) {
      if (pathname.startsWith(prefix + '/') || pathname === prefix) {
        return handleProxy(request, target, prefix)
      }
    }

    return env.ASSETS.fetch(request)
  },
}
