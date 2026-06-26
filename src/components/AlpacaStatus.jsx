import { useEffect, useState } from 'react'
import { getAlpacaAccount } from '../utils/alpacaApi'

export default function AlpacaStatus() {
  const [status, setStatus] = useState('checking') // checking | connected | error
  const [message, setMessage] = useState('Connecting to Alpaca...')

  useEffect(() => {
    let cancelled = false

    getAlpacaAccount()
      .then((account) => {
        if (cancelled) return
        setStatus('connected')
        setMessage(`Alpaca connected · account ${account.account_number} · ${account.status}`)
      })
      .catch((err) => {
        if (cancelled) return
        setStatus('error')
        setMessage(err.message)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const label =
    status === 'connected' ? 'Alpaca Connected' : status === 'error' ? 'Alpaca Error' : 'Connecting...'

  return (
    <div className={`alpaca-status alpaca-status-${status}`} title={message}>
      <span className="alpaca-status-dot" />
      <span className="alpaca-status-label">{label}</span>
    </div>
  )
}
