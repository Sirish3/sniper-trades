import { CheckIcon, XIcon, AlertIcon } from './Icons'

function sentimentClass(value) {
  const v = (value || '').toLowerCase()
  if (v.includes('bull') || v.includes('buy') || v.includes('accumulat') || v.includes('increas') || v === 'go') {
    return 'positive'
  }
  if (v.includes('bear') || v.includes('sell') || v.includes('distribut') || v.includes('decreas') || v === 'exit') {
    return 'negative'
  }
  return 'neutral'
}

export function StatusIcon({ status }) {
  if (status === 'pass') return <CheckIcon className="metric-icon metric-icon-pass" />
  if (status === 'fail') return <XIcon className="metric-icon metric-icon-fail" />
  return <AlertIcon className="metric-icon metric-icon-warn" />
}

function VerdictBadge({ verdict }) {
  const cls = verdict === 'GO' ? 'positive' : verdict === 'EXIT' ? 'negative' : 'neutral'
  return <span className={`verdict-badge tag-${cls}`}>{verdict}</span>
}

export function Card({ title, className = '', children }) {
  return (
    <section className={`result-card ${className}`}>
      <h3 className="result-card-title">{title}</h3>
      {children}
    </section>
  )
}

export function Stat({ label, value, className = '' }) {
  return (
    <div className="result-stat">
      <span className="result-stat-label">{label}</span>
      <span className={`result-stat-value ${className}`}>{value}</span>
    </div>
  )
}

export function ScoreGauge({ label, score, max }) {
  const pct = max ? Math.max(0, Math.min(100, Math.round((score / max) * 100))) : 0
  return (
    <div className="score-gauge">
      <div className="score-gauge-head">
        <span className="score-gauge-label">{label}</span>
        <span className="score-gauge-value">{score} / {max}</span>
      </div>
      <div className="score-gauge-bar">
        <div className="score-gauge-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function MetricsList({ metrics }) {
  return (
    <ul className="metrics-list">
      {metrics.map((m) => (
        <li key={m.name} className="metric">
          <StatusIcon status={m.status} />
          <div className="metric-body">
            <div className="metric-name">{m.name}</div>
            <div className="metric-value">{m.value}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function ResultHeader({ data }) {
  return (
    <div className="result-header">
      <div className="result-header-top">
        <div className="result-title">
          <span className="result-ticker">{data.ticker}</span>
          <span className="result-company">{data.companyName}</span>
          {data.sector && <span className="result-sector-tag">{data.sector}</span>}
        </div>
        <VerdictBadge verdict={data.verdict} />
      </div>

      <div className="result-stats">
        <Stat label="Price" value={`$${Number(data.price).toFixed(2)}`} />
        <Stat label="Market Cap" value={data.marketCap} />
        <Stat label="52-Week Range" value={`$${data.week52Low} – $${data.week52High}`} />
        <Stat label="Off High" value={`${data.priceOffHigh}%`} />
      </div>

      <p className="result-verdict-reason">{data.verdictReason}</p>
      {data.verdictSubtitle && <p className="result-verdict-subtitle">{data.verdictSubtitle}</p>}
    </div>
  )
}

function TechnicalSection({ data }) {
  return (
    <Card title="Technical Analysis" className="card-technical">
      <div className="score-row">
        <ScoreGauge label="Entry Score" score={data.entryScore} max={data.entryMetrics.length} />
        <ScoreGauge label="Exit Score" score={data.exitScore} max={data.exitMetrics.length} />
      </div>
      <div className="metrics-columns">
        <div className="metrics-column">
          <h4>Entry Checklist</h4>
          <MetricsList metrics={data.entryMetrics} />
        </div>
        <div className="metrics-column">
          <h4>Exit Checklist</h4>
          <MetricsList metrics={data.exitMetrics} />
        </div>
      </div>
    </Card>
  )
}

function InstitutionalSection({ data }) {
  return (
    <Card title="Institutional Ownership" className="card-institutional">
      <div className="result-stats">
        <Stat label="Ownership" value={`${data.ownershipPercent}%`} />
        <Stat label="Net Flow" value={data.netFlow} className={`tag-${sentimentClass(data.netFlow)}`} />
        <Stat label="QoQ Change" value={data.quarterOverQuarterChange} />
      </div>

      <h4>Top Holders</h4>
      <table className="data-table">
        <thead>
          <tr>
            <th>Holder</th>
            <th>% Owned</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {data.topHolders.map((h) => (
            <tr key={h.name}>
              <td>{h.name}</td>
              <td>{h.percentOwned}%</td>
              <td className={`tag-${sentimentClass(h.change)}`}>{h.change}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flow-columns">
        <div className="flow-column">
          <h4>Increasing</h4>
          <ul className="flow-list">
            {data.increasing.map((i) => (
              <li key={i.name}>
                <strong>{i.name}</strong> — {i.detail}
              </li>
            ))}
          </ul>
        </div>
        <div className="flow-column">
          <h4>Decreasing</h4>
          <ul className="flow-list">
            {data.decreasing.map((i) => (
              <li key={i.name}>
                <strong>{i.name}</strong> — {i.detail}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="section-signal">
        <span className={`tag-${sentimentClass(data.signal)}`}>{data.signal}</span>
      </p>
      <p className="section-interpretation">{data.interpretation}</p>
    </Card>
  )
}

function WhaleActivitySection({ data }) {
  return (
    <Card title="Whale & Dark Pool Activity" className="card-whale">
      <div className="result-stats">
        <Stat
          label="Net Positioning"
          value={data.netPositioning}
          className={`tag-${sentimentClass(data.netPositioning)}`}
        />
        <Stat
          label="Dark Pool Sentiment"
          value={data.darkPoolSentiment}
          className={`tag-${sentimentClass(data.darkPoolSentiment)}`}
        />
      </div>

      <h4>Recent Block Trades</h4>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Size</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {data.recentBlockTrades.map((t, i) => (
            <tr key={i}>
              <td>{t.date}</td>
              <td className={`tag-${sentimentClass(t.type)}`}>{t.type}</td>
              <td>{t.size}</td>
              <td>{t.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Unusual Options Activity</h4>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Detail</th>
            <th>Premium</th>
            <th>Sentiment</th>
          </tr>
        </thead>
        <tbody>
          {data.unusualOptions.map((o, i) => (
            <tr key={i}>
              <td>{o.date}</td>
              <td>{o.type}</td>
              <td>{o.detail}</td>
              <td>{o.premium}</td>
              <td className={`tag-${sentimentClass(o.sentiment)}`}>{o.sentiment}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="section-summary">{data.summary}</p>
    </Card>
  )
}

function PoliticalTradesSection({ data }) {
  return (
    <Card title="Congressional Trades" className="card-political">
      <div className="result-stats">
        <Stat label="Signal" value={data.signal} className={`tag-${sentimentClass(data.signal)}`} />
        <Stat label="Net Activity" value={data.netActivity} />
      </div>

      {data.hasRecentTrades ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Chamber</th>
              <th>Type</th>
              <th>Size</th>
              <th>Disclosed</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.trades.map((t, i) => (
              <tr key={i}>
                <td>
                  {t.member} <span className="text-muted">({t.party})</span>
                </td>
                <td>{t.chamber}</td>
                <td className={`tag-${sentimentClass(t.type)}`}>{t.type}</td>
                <td>{t.sizeRange}</td>
                <td>{t.dateDisclosed}</td>
                <td>{t.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="section-empty">No recent congressional trades.</p>
      )}

      <p className="section-interpretation">{data.interpretation}</p>
    </Card>
  )
}

function SocialSentimentSection({ data }) {
  const { bullish, neutral, bearish } = data.sentimentBreakdown

  return (
    <Card title="Social Sentiment" className="card-social">
      <div className="result-stats">
        <Stat
          label="Overall"
          value={data.overallSentiment}
          className={`tag-${sentimentClass(data.overallSentiment)}`}
        />
        <Stat label="Mention Volume" value={`${data.mentionVolumeTrend} (${data.mentionVolumeVsAvg})`} />
      </div>

      <div className="sentiment-bar">
        <div className="sentiment-bar-segment sentiment-bar-bullish" style={{ width: `${bullish}%` }} />
        <div className="sentiment-bar-segment sentiment-bar-neutral" style={{ width: `${neutral}%` }} />
        <div className="sentiment-bar-segment sentiment-bar-bearish" style={{ width: `${bearish}%` }} />
      </div>
      <div className="sentiment-bar-legend">
        <span className="tag-positive">Bullish {bullish}%</span>
        <span className="tag-neutral">Neutral {neutral}%</span>
        <span className="tag-negative">Bearish {bearish}%</span>
      </div>

      <div className="trending-tags">
        {data.trendingOn.map((t) => (
          <span key={t} className="trending-tag">
            {t}
          </span>
        ))}
      </div>

      <div className="narrative-columns">
        <div className="narrative-column">
          <h4>Bullish Narratives</h4>
          <ul className="narrative-list">
            {data.bullishNarratives.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
        <div className="narrative-column">
          <h4>Bearish Narratives</h4>
          <ul className="narrative-list">
            {data.bearishNarratives.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="result-stats">
        <Stat label="Influencer Activity" value={data.influencerActivity} />
        <Stat label="Retail vs Institutional" value={data.retailVsInstitutional} />
      </div>

      <p className={data.crowdedTradeRisk ? 'section-warning' : 'section-summary'}>
        {data.crowdedTradeRisk && <AlertIcon className="warning-icon" />}
        {data.crowdedTradeFlag}
      </p>
    </Card>
  )
}

export default function AnalysisResult({ data }) {
  return (
    <div className="analysis-result">
      <ResultHeader data={data} />
      <p className="bottom-line">{data.bottomLine}</p>
      <TechnicalSection data={data.technical} />
      <div className="result-grid">
        <InstitutionalSection data={data.institutional} />
        <WhaleActivitySection data={data.whaleActivity} />
        <PoliticalTradesSection data={data.politicalTrades} />
        <SocialSentimentSection data={data.socialSentiment} />
      </div>
    </div>
  )
}
