import { useState } from 'react'
import { SettingsIcon, XIcon } from './Icons'

export default function ApiKeySettings({ apiKey, onSave }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(apiKey)

  const handleSave = () => {
    onSave(value.trim())
    setOpen(false)
  }

  return (
    <div className="api-key-settings">
      <button
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        title="Anthropic API key settings"
        aria-label="API key settings"
      >
        <SettingsIcon />
        {!apiKey && <span className="settings-dot" />}
      </button>

      {open && (
        <div className="settings-popover">
          <div className="settings-popover-header">
            <span>Anthropic API Key</span>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              <XIcon width={14} height={14} />
            </button>
          </div>
          <p className="settings-hint">
            Stored only in this browser&rsquo;s local storage — never sent anywhere except
            api.anthropic.com. Get a key at{' '}
            <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            .
          </p>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-ant-..."
            className="settings-input"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn btn-primary" onClick={handleSave}>
            Save key
          </button>
        </div>
      )}
    </div>
  )
}
