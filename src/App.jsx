import { useState } from 'react'
import './App.css'
import ApiKeySettings from './components/ApiKeySettings'
import AlpacaStatus from './components/AlpacaStatus'
import Footer from './components/Footer'
import WeekHighScreener from './components/WeekHighScreener'
import EconomicCalendar from './components/EconomicCalendar'

const STORAGE_KEY = 'swing-trade-analyzer-api-key'

function App() {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(STORAGE_KEY) || import.meta.env.VITE_ANTHROPIC_API_KEY || ''
  )
  const [activeTab, setActiveTab] = useState('weekhigh')

  const handleSaveApiKey = (key) => {
    setApiKey(key)
    localStorage.setItem(STORAGE_KEY, key)
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
          className={`tab-btn ${activeTab === 'weekhigh' ? 'active' : ''}`}
          onClick={() => setActiveTab('weekhigh')}
        >
          52W High
        </button>
        <button
          className={`tab-btn ${activeTab === 'econcalendar' ? 'active' : ''}`}
          onClick={() => setActiveTab('econcalendar')}
        >
          Economic Calendar
        </button>
      </nav>

      <main className="app-main">
        {activeTab === 'weekhigh' && <WeekHighScreener />}
        {activeTab === 'econcalendar' && <EconomicCalendar />}
      </main>

      <Footer />
    </div>
  )
}

export default App
