import { useEffect, useId, useRef, useState } from 'react'

// TradingView's official "Advanced Chart" widget script (free, no API key
// or account — https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/).
// Loaded once and shared: instantiating multiple `new TradingView.widget()`
// calls against different container_ids is the supported way to have
// several widgets coexist on one page.
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
  studies = ['MAExp@tv-basicstudies'],
  studiesOverrides = { 'moving average exponential.length': 10 },
  height = 550,
  containerId,
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const widgetId = containerId || `tv_widget_${reactId}`
  const containerRef = useRef(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)

    loadTradingViewScript().then(() => {
      if (cancelled || !containerRef.current) return

      const widget = new window.TradingView.widget({
        autosize: true,
        symbol,
        interval,
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
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
        if (!cancelled) setReady(true)
      })
    })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, widgetId, JSON.stringify(studies), JSON.stringify(studiesOverrides)])

  return (
    <div className="tv-widget-wrap" style={{ height }}>
      {!ready && <div className="tv-widget-skeleton" />}
      <div id={widgetId} ref={containerRef} className="tv-widget-container" style={{ visibility: ready ? 'visible' : 'hidden' }} />
    </div>
  )
}
