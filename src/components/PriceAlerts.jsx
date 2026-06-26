// Displays the localStorage watch list (see utils/priceAlerts.js). Pure
// presentation — WeekHighScreener owns the state, and a "Set Alert" click
// on any built trade plan's Entry/Stop/Trim1/Trim2 row shows up here
// immediately without a page reload.
function PriceAlerts({ alerts, onRemove }) {
  return (
    <div className="result-card price-alerts">
      <h3 className="result-card-title">
        Price Alerts {alerts.length > 0 && <span className="text-muted">({alerts.length})</span>}
      </h3>
      {alerts.length === 0 ? (
        <p className="section-empty">No price alerts set yet.</p>
      ) : (
        <div className="price-alert-list">
          {alerts.map((a) => (
            <div className="price-alert-row" key={a.id}>
              <span className="result-ticker mono">{a.symbol}</span>
              <span className="price-alert-label text-muted">{a.label}</span>
              <span className="price-alert-value mono">${a.price.toFixed(2)}</span>
              <button type="button" className="btn" onClick={() => onRemove(a.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default PriceAlerts
