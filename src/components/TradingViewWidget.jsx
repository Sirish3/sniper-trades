import { useEffect, useId, useRef, useState } from 'react'

// TradingView's official "Advanced Chart" widget script (free, no API key
// or account — https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/).
// Loaded once and shared: instantiating multiple `new TradingView.widget()`
// calls against different container_ids is the supported way to have
// several widgets coexist on one page.
//
// Note: TradingView's other official embed (JSON config as literal text
// inside a <script src="embed-widget-advanced-chart.js"> tag) was tried
// first, but its bundled loader threw `JSON.parse("[object Object]")` when
// reading the config back out of the script tag — a real bug in how that
// variant consumes inline content, not a naming issue. This constructor-
// based method passes the config as a live JS object instead, so there's
// no serialize/reparse step to break, and it's unambiguously documented to
// support `studies`/`studies_overrides`/`container_id`.
const TV_SCRIPT_SRC = 'https://s3.tradingview.com/tv.js'
let tvScriptPromise = null

function loadTradingViewScript() {
  if (window.TradingView) return Promise.resolve()
  if (!tvScriptPromise) {
    tvScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = TV_SCRIPT_SRC
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load TradingView widget script'))
      document.head.appendChild(script)
    })
  }
  return tvScriptPromise
}

// Reusable embed for TradingView's free Advanced Chart widget. Symbol and
// studies are props (not hardcoded) so this can be dropped in for any
// ticker/study combination. containerId defaults to a per-instance React id
// so multiple charts can coexist on the same page without collisions.
export default function TradingViewWidget({
  symbol = 'NASDAQ:QQQ',
  interval = 'D',
  // "Moving Average" (SMA) with length 1 just traces the raw close price —
  // the standard trick for a distinctly-colorable "price line" overlay on
  // top of candles, since the main series itself can only be one style
  // (candles OR line, not both) and its color otherwise follows candle
  // up/down state rather than a fixed color.
  studies = ['MASimple@tv-basicstudies', 'MAExp@tv-basicstudies'],
  studiesOverrides = {
    'moving average.length': 1,
    'moving average.plot.color': '#00c896', // green, matches --green
    'moving average exponential.length': 10,
    'moving average exponential.plot.color': '#ff4c4c', // red, matches --red
  },
  height = 550,
  containerId,
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const widgetId = containerId || `tv_widget_${reactId}`
  const containerRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setFailed(false)

    // The script can hang instead of erroring outright (blocked by a
    // content/ad blocker, flaky network, etc.) — without this, a failure
    // leaves the skeleton spinning forever with no feedback.
    const timeout = setTimeout(() => {
      if (!cancelled) setFailed(true)
    }, 10000)

    loadTradingViewScript()
      .then(() => {
        if (cancelled || !containerRef.current) return

        const widget = new window.TradingView.widget({
          autosize: true,
          symbol,
          interval,
          timezone: 'Etc/UTC',
          theme: 'dark',
          style: '1', // Candles — price line and EMA(10) are overlaid as studies below
          locale: 'en',
          toolbar_bg: '#13161e',
          enable_publishing: false,
          // Shows the built-in 1D/1M/3M/YTD/1Y/5Y/ALL range toolbar.
          withdateranges: true,
          range: '12M',
          allow_symbol_change: true,
          studies,
          studies_overrides: studiesOverrides,
          container_id: widgetId,
        })

        widget.onChartReady(() => {
          clearTimeout(timeout)
          if (!cancelled) setReady(true)
        })
      })
      .catch(() => {
        clearTimeout(timeout)
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, widgetId, JSON.stringify(studies), JSON.stringify(studiesOverrides)])

  const heightVar = { '--tv-height': `${height}px` }

  if (failed) {
    return (
      <div className="tv-widget-wrap tv-widget-fallback" style={heightVar}>
        <span>Chart failed to load.</span>
        <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`} target="_blank" rel="noopener noreferrer">
          View {symbol} on TradingView →
        </a>
      </div>
    )
  }

  return (
    <div className="tv-widget-wrap" style={heightVar}>
      {!ready && <div className="tv-widget-skeleton" />}
      <div id={widgetId} ref={containerRef} className="tv-widget-container" style={{ height: '100%', width: '100%', visibility: ready ? 'visible' : 'hidden' }} />
    </div>
  )
}
