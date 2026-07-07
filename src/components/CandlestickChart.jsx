import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Line,
} from 'recharts'

// Draws the high-low wick and open-close body for one candle. Recharts
// already maps the Bar's [low, high] range onto pixel `y`/`height` via the
// YAxis scale — `y` is the pixel for `high` (top) and `y + height` is the
// pixel for `low` (bottom) — so open/close just interpolate linearly
// within that same range rather than needing a second scale.
function Candle({ x, y, width, height, payload }) {
  const { open, close, high, low } = payload
  const isUp = close >= open
  const color = isUp ? 'var(--green)' : 'var(--red)'

  if (high === low) return null // no range for this bar yet (shouldn't happen for real bars)

  const priceToY = (price) => y + ((high - price) / (high - low)) * height
  const bodyTop = priceToY(Math.max(open, close))
  const bodyBottom = priceToY(Math.min(open, close))
  const bodyHeight = Math.max(bodyBottom - bodyTop, 1) // 1px minimum so a doji still shows

  const wickX = x + width / 2
  const bodyX = x + width * 0.2
  const bodyWidth = width * 0.6

  return (
    <g>
      <line x1={wickX} x2={wickX} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={bodyX} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} />
    </g>
  )
}

function CandleTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  return (
    <div className="bt-tooltip">
      <div className="bt-tooltip-date">{label}</div>
      <div className="bt-tooltip-row">O {row.open.toFixed(2)}</div>
      <div className="bt-tooltip-row">H {row.high.toFixed(2)}</div>
      <div className="bt-tooltip-row">L {row.low.toFixed(2)}</div>
      <div className="bt-tooltip-row">C {row.close.toFixed(2)}</div>
    </div>
  )
}

// Merges each trendline's anchor points into the candle series as sparse,
// per-trendline dataKeys (null everywhere except at the anchor dates) —
// Recharts draws a straight segment between just those two points via
// `connectNulls` on a <Line>, which is the standard way to overlay an
// arbitrary two-point line on a category (date) x-axis.
function withTrendlines(candles, trendlines) {
  if (!trendlines?.length) return candles
  const byDate = new Map(candles.map((c) => [c.date, { ...c }]))
  trendlines.forEach((trendline, i) => {
    trendline.points?.forEach(([date, price]) => {
      const row = byDate.get(date)
      if (row) row[`trend${i}`] = price
    })
  })
  return [...byDate.values()]
}

export default function CandlestickChart({ candles, annotations, height = 380 }) {
  if (!candles?.length) return null

  const { trendlines = [], zones = [], hlines = [] } = annotations || {}
  const chartData = withTrendlines(candles, trendlines)
  const prices = [
    ...candles.flatMap((c) => [c.high, c.low]),
    ...hlines.map((h) => h.y),
    ...zones.flatMap((z) => [z.y1, z.y2]),
    ...trendlines.flatMap((t) => t.points?.map(([, price]) => price) || []),
  ]
  const domain = [Math.min(...prices) * 0.98, Math.max(...prices) * 1.02]

  return (
    <div className="cp-chart">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
            interval={Math.max(1, Math.floor(chartData.length / 8))}
          />
          <YAxis
            domain={domain}
            tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            width={48}
          />
          <Tooltip content={<CandleTooltip />} />

          {zones.map((zone, i) => (
            <ReferenceArea
              key={`zone-${i}`}
              y1={zone.y1}
              y2={zone.y2}
              fill={zone.color || 'var(--green)'}
              fillOpacity={0.12}
              stroke={zone.color || 'var(--green)'}
              strokeOpacity={0.4}
              label={zone.label ? { value: zone.label, position: 'insideTopLeft', fontSize: 10, fill: zone.color || 'var(--green)' } : undefined}
            />
          ))}

          {hlines.map((hline, i) => (
            <ReferenceLine
              key={`hline-${i}`}
              y={hline.y}
              stroke={hline.color || 'var(--red)'}
              strokeDasharray="4 4"
              label={hline.label ? { value: `${hline.label} ${hline.y}`, position: 'insideBottomLeft', fontSize: 10, fill: hline.color || 'var(--red)' } : undefined}
            />
          ))}

          <Bar dataKey={(row) => [row.low, row.high]} shape={<Candle />} isAnimationActive={false} />

          {trendlines.map((trendline, i) => (
            <Line
              key={`trend-${i}`}
              dataKey={`trend${i}`}
              stroke={trendline.color || 'var(--purple)'}
              strokeDasharray={trendline.style === 'dashed' ? '4 4' : undefined}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
