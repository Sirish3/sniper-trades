export default function MetricCard({ label, value, up, down }) {
  const cls = up ? ' bt-metric--up' : down ? ' bt-metric--down' : ''
  return (
    <div className={`bt-metric${cls}`}>
      <div className="bt-metric-value">{value}</div>
      <div className="bt-metric-label">{label}</div>
    </div>
  )
}
