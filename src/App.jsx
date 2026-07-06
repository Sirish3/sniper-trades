import { useState } from 'react'
import './App.css'
import ApiKeySettings from './components/ApiKeySettings'
import AlpacaStatus from './components/AlpacaStatus'
import Footer from './components/Footer'
import AnalysisResult from './components/AnalysisResult'
import WeekHighScreener from './components/WeekHighScreener'
import SwingScanner from './components/SwingScanner'
import EconomicCalendar from './components/EconomicCalendar'
import EarningsCalendar from './components/EarningsCalendar'
import { SearchIcon, LoaderIcon } from './components/Icons'
import { analyzeTicker } from './utils/claudeApi'
import { getTechnicalAnalysis } from './utils/marketData'

const STORAGE_KEY = 'swing-trade-analyzer-api-key'

function App() {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(STORAGE_KEY) || import.meta.env.VITE_ANTHROPIC_API_KEY || ''
  )
  const [input, setInput] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('analysis')
  const [scannerTickers, setScannerTickers] = useState([])

  const handleSaveApiKey = (key) => {
    setApiKey(key)
    localStorage.setItem(STORAGE_KEY, key)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const ticker = input.trim()
    if (!ticker || loading) return

    setLoading(true)
    setError(null)
    try {
      const technical = await getTechnicalAnalysis(ticker)
      const data = await analyzeTicker(ticker, apiKey, technical.summary)
      setResult({
        ...data,
        price: technical.price,
        week52High: technical.week52High,
        week52Low: technical.week52Low,
        priceOffHigh: technical.priceOffHigh,
        technical: technical.technical,
      })
    } catch (err) {
      setError(err.message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <h1 className="brand-name">
            Swing Trade Analyzer <span className="brand-pro">Pro</span>
            <span className="brand-version">v1</span>
          </h1>
        </div>
        <div className="header-actions">
          <AlpacaStatus />
          <ApiKeySettings apiKey={apiKey} onSave={handleSaveApiKey} />
        </div>
      </header>

      <nav className="tab-nav">
        <button
          className={`tab-btn ${activeTab === 'analysis' ? 'active' : ''}`}
          onClick={() => setActiveTab('analysis')}
        >
          Analysis
        </button>
        <button
          className={`tab-btn ${activeTab === 'weekhigh' ? 'active' : ''}`}
          onClick={() => setActiveTab('weekhigh')}
        >
          52W High
        </button>
        <button
          className={`tab-btn ${activeTab === 'scanner' ? 'active' : ''}`}
          onClick={() => setActiveTab('scanner')}
        >
          Scanner
        </button>
        <button
          className={`tab-btn ${activeTab === 'econcalendar' ? 'active' : ''}`}
          onClick={() => setActiveTab('econcalendar')}
        >
          Economic Calendar
        </button>
        <button
          className={`tab-btn ${activeTab === 'earnings' ? 'active' : ''}`}
          onClick={() => setActiveTab('earnings')}
        >
          Earnings
        </button>
      </nav>

      <main className="app-main">
        {activeTab === 'analysis' && (
          <>
            <form className="analysis-form" onSubmit={handleSubmit}>
              <div className="analysis-input-wrap">
                <SearchIcon className="analysis-input-icon" />
                <input
                  className="analysis-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Enter a ticker or question"
                />
              </div>
              <button type="submit" className="btn btn-primary analyze-btn" disabled={loading || !input.trim()}>
                {loading ? (
                  <>
                    <LoaderIcon className="spin-icon" />
                    Analysing...
                  </>
                ) : (
                  'Analyse'
                )}
              </button>
            </form>

            {error && <div className="analysis-error">{error}</div>}

            {result && <AnalysisResult data={result} />}
          </>
        )}

        {activeTab === 'weekhigh' && <WeekHighScreener />}
        {activeTab === 'scanner' && <SwingScanner onResults={setScannerTickers} />}
        {activeTab === 'econcalendar' && <EconomicCalendar />}
        {activeTab === 'earnings' && <EarningsCalendar scanTickers={scannerTickers} />}
      </main>

      <Footer />
    </div>
  )
}

export default App
