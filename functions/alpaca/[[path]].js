export async function onRequest(context) {
  const { request } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      },
    })
  }

  const afterPrefix = request.url.replace(/^https?:\/\/[^/]+\/alpaca/, '')
  const target = `https://paper-api.alpaca.markets${afterPrefix}`

  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        'APCA-API-KEY-ID': request.headers.get('APCA-API-KEY-ID') || '',
        'APCA-API-SECRET-KEY': request.headers.get('APCA-API-SECRET-KEY') || '',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
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
