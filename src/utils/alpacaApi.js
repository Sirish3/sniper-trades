const BASE_URL = 'https://paper-api.alpaca.markets/v2'

export function authHeaders() {
  const keyId = import.meta.env.VITE_ALPACA_KEY_ID
  const secretKey = import.meta.env.VITE_ALPACA_SECRET_KEY

  if (!keyId || !secretKey) {
    throw new Error('Alpaca API credentials are not configured.')
  }

  return {
    'APCA-API-KEY-ID': keyId,
    'APCA-API-SECRET-KEY': secretKey,
  }
}

export async function getAlpacaAccount() {
  let response
  try {
    response = await fetch(`${BASE_URL}/account`, { headers: authHeaders() })
  } catch {
    throw new Error('Network error — could not reach Alpaca.')
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Alpaca authentication failed — check API key/secret.')
    }
    throw new Error(`Alpaca request failed (${response.status})`)
  }

  return response.json()
}
