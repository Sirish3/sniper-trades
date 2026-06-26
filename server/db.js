// SQLite persistence (better-sqlite3 — synchronous, no native build issues
// expected on a supported platform since it ships prebuilt binaries).
// Mirrors the table set from the original spec, trimmed to what scanner.js/
// alerts.js/api.js actually read and write.

import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEnv } from './env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dbPath = getEnv('DATABASE_PATH') || path.join(here, 'swing_trader.db')

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    sector_etf TEXT,
    permanent_flag INTEGER NOT NULL DEFAULT 0,
    added_date TEXT NOT NULL,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS etf_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    etf_ticker TEXT NOT NULL,
    etf_name TEXT,
    category TEXT,
    cur_price REAL,
    high_52w REAL,
    pct_from_high REAL,
    status TEXT,
    ret_1m REAL,
    ret_3m REAL,
    scanned_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_etf_status_ticker_time ON etf_status (etf_ticker, scanned_at);

  CREATE TABLE IF NOT EXISTS scan_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    etf_source TEXT,
    cur_price REAL,
    high_52w REAL,
    pct_from_high REAL,
    vol_ratio REAL,
    rs_rank INTEGER,
    ret_1m REAL,
    ret_3m REAL,
    atr_14 REAL,
    ema_10 REAL,
    ema_21 REAL,
    ema_50 REAL,
    rsi_14 REAL,
    macd_hist REAL,
    adx_14 REAL,
    alligator_phase TEXT,
    signal_type TEXT,
    signal_grade TEXT,
    scan_time TEXT NOT NULL,
    scan_run_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scan_results_run ON scan_results (scan_run_id);
  CREATE INDEX IF NOT EXISTS idx_scan_results_ticker_time ON scan_results (ticker, scan_time);

  CREATE TABLE IF NOT EXISTS alerts_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_grade TEXT,
    price REAL,
    atr_stop REAL,
    trim1_price REAL,
    trim2_price REAL,
    position_size REAL,
    risk_dollar REAL,
    pct_from_high REAL,
    vol_ratio REAL,
    rs_rank INTEGER,
    sector_etf TEXT,
    thesis TEXT,
    scan_time TEXT NOT NULL,
    sent_at TEXT,
    delivery_method TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_ticker_signal_time ON alerts_log (ticker, signal_type, scan_time);

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    shares INTEGER NOT NULL,
    avg_cost REAL NOT NULL,
    entry_date TEXT NOT NULL,
    initial_stop REAL,
    current_stop REAL,
    trim1_price REAL,
    trim2_price REAL,
    trim1_executed INTEGER NOT NULL DEFAULT 0,
    trim2_executed INTEGER NOT NULL DEFAULT 0,
    atr_at_entry REAL,
    sector_etf TEXT,
    signal_type TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    opened_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status);

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER REFERENCES positions(id),
    ticker TEXT NOT NULL,
    action TEXT NOT NULL,
    shares INTEGER NOT NULL,
    price REAL NOT NULL,
    total REAL NOT NULL,
    pnl REAL,
    pnl_pct REAL,
    reason TEXT,
    atr_stop_at_trade REAL,
    executed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_position ON trades (position_id);

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_value REAL,
    cash_balance REAL,
    open_positions_value REAL,
    realized_pnl REAL,
    unrealized_pnl REAL,
    snapshot_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sector_rotation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    etf_ticker TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT,
    price REAL,
    pct_from_high REAL,
    changed_at TEXT NOT NULL
  );
`)

function nowIso() {
  return new Date().toISOString()
}

// ── watchlist ──
export function upsertWatchlistTicker({ ticker, sectorEtf, permanent = false, notes = null }) {
  db.prepare(`
    INSERT INTO watchlist (ticker, sector_etf, permanent_flag, added_date, notes, active)
    VALUES (@ticker, @sectorEtf, @permanent, @addedDate, @notes, 1)
    ON CONFLICT(ticker) DO UPDATE SET sector_etf = @sectorEtf, active = 1
  `).run({ ticker, sectorEtf, permanent: permanent ? 1 : 0, addedDate: nowIso(), notes })
}

export function getWatchlist() {
  return db.prepare('SELECT * FROM watchlist WHERE active = 1').all()
}

export function removeFromWatchlist(ticker) {
  db.prepare('UPDATE watchlist SET active = 0 WHERE ticker = ? AND permanent_flag = 0').run(ticker)
}

// ── etf_status / sector_rotation_log ──
export function recordEtfStatus(status) {
  const previous = db.prepare('SELECT status FROM etf_status WHERE etf_ticker = ? ORDER BY scanned_at DESC LIMIT 1').get(status.etfTicker)

  db.prepare(`
    INSERT INTO etf_status (etf_ticker, etf_name, category, cur_price, high_52w, pct_from_high, status, ret_1m, ret_3m, scanned_at)
    VALUES (@etfTicker, @etfName, @category, @curPrice, @high52w, @pctFromHigh, @status, @ret1m, @ret3m, @scannedAt)
  `).run({ ...status, scannedAt: nowIso() })

  if (previous && previous.status !== status.status) {
    db.prepare(`
      INSERT INTO sector_rotation_log (etf_ticker, previous_status, new_status, price, pct_from_high, changed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(status.etfTicker, previous.status, status.status, status.curPrice, status.pctFromHigh, nowIso())
  }
}

export function getLatestEtfStatuses() {
  return db.prepare(`
    SELECT e.* FROM etf_status e
    WHERE e.id IN (SELECT MAX(id) FROM etf_status GROUP BY etf_ticker)
    ORDER BY e.pct_from_high DESC
  `).all()
}

export function getSectorRotationLog(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  return db.prepare('SELECT * FROM sector_rotation_log WHERE changed_at >= ? ORDER BY changed_at DESC').all(since)
}

// ── scan_results ──
export function insertScanResult(result, scanRunId) {
  db.prepare(`
    INSERT INTO scan_results (
      ticker, etf_source, cur_price, high_52w, pct_from_high, vol_ratio, rs_rank, ret_1m, ret_3m,
      atr_14, ema_10, ema_21, ema_50, rsi_14, macd_hist, adx_14, alligator_phase,
      signal_type, signal_grade, scan_time, scan_run_id
    ) VALUES (
      @ticker, @etfSource, @curPrice, @high52w, @pctFromHigh, @volRatio, @rsRank, @ret1m, @ret3m,
      @atr14, @ema10, @ema21, @ema50, @rsi14, @macdHist, @adx14, @alligatorPhase,
      @signalType, @signalGrade, @scanTime, @scanRunId
    )
  `).run({ ...result, scanTime: nowIso(), scanRunId })
}

export function getLatestScanResults() {
  const latestRun = db.prepare('SELECT scan_run_id FROM scan_results ORDER BY id DESC LIMIT 1').get()
  if (!latestRun) return []
  return db.prepare('SELECT * FROM scan_results WHERE scan_run_id = ? ORDER BY signal_grade, pct_from_high DESC').all(latestRun.scan_run_id)
}

export function getScanResultsBySignal(signalType) {
  return getLatestScanResults().filter((r) => r.signal_type === signalType)
}

export function getScanHistory(limit = 500, offset = 0) {
  return db.prepare('SELECT * FROM scan_results ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset)
}

// ── alerts_log ──
export function wasAlertSentRecently(ticker, signalType, withinHours = 24) {
  const since = new Date(Date.now() - withinHours * 3600000).toISOString()
  const row = db.prepare(`
    SELECT id FROM alerts_log WHERE ticker = ? AND signal_type = ? AND sent_at >= ? LIMIT 1
  `).get(ticker, signalType, since)
  return !!row
}

export function insertAlert(alert) {
  const info = db.prepare(`
    INSERT INTO alerts_log (
      ticker, signal_type, signal_grade, price, atr_stop, trim1_price, trim2_price,
      position_size, risk_dollar, pct_from_high, vol_ratio, rs_rank, sector_etf, thesis,
      scan_time, sent_at, delivery_method, acknowledged
    ) VALUES (
      @ticker, @signalType, @signalGrade, @price, @atrStop, @trim1Price, @trim2Price,
      @positionSize, @riskDollar, @pctFromHigh, @volRatio, @rsRank, @sectorEtf, @thesis,
      @scanTime, @sentAt, @deliveryMethod, 0
    )
  `).run({ ...alert, scanTime: nowIso(), sentAt: nowIso() })
  return info.lastInsertRowid
}

export function getAlerts(limit = 200, offset = 0) {
  return db.prepare('SELECT * FROM alerts_log ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset)
}

export function getUnacknowledgedAlerts() {
  return db.prepare('SELECT * FROM alerts_log WHERE acknowledged = 0 ORDER BY id DESC').all()
}

export function acknowledgeAlert(id) {
  db.prepare('UPDATE alerts_log SET acknowledged = 1 WHERE id = ?').run(id)
}

// ── positions ──
export function insertPosition(position) {
  const info = db.prepare(`
    INSERT INTO positions (
      ticker, shares, avg_cost, entry_date, initial_stop, current_stop,
      trim1_price, trim2_price, atr_at_entry, sector_etf, signal_type, status, opened_at
    ) VALUES (
      @ticker, @shares, @avgCost, @entryDate, @initialStop, @currentStop,
      @trim1Price, @trim2Price, @atrAtEntry, @sectorEtf, @signalType, 'OPEN', @openedAt
    )
  `).run({ ...position, openedAt: nowIso() })
  return info.lastInsertRowid
}

export function getOpenPositions() {
  return db.prepare("SELECT * FROM positions WHERE status = 'OPEN'").all()
}

export function getPosition(id) {
  return db.prepare('SELECT * FROM positions WHERE id = ?').get(id)
}

export function updatePositionStop(id, currentStop) {
  db.prepare('UPDATE positions SET current_stop = ? WHERE id = ?').run(currentStop, id)
}

export function markTrimExecuted(id, trimNumber) {
  const column = trimNumber === 1 ? 'trim1_executed' : 'trim2_executed'
  db.prepare(`UPDATE positions SET ${column} = 1 WHERE id = ?`).run(id)
}

export function closePosition(id) {
  db.prepare("UPDATE positions SET status = 'CLOSED', closed_at = ? WHERE id = ?").run(nowIso(), id)
}

// ── trades ──
export function insertTrade(trade) {
  db.prepare(`
    INSERT INTO trades (position_id, ticker, action, shares, price, total, pnl, pnl_pct, reason, atr_stop_at_trade, executed_at)
    VALUES (@positionId, @ticker, @action, @shares, @price, @total, @pnl, @pnlPct, @reason, @atrStopAtTrade, @executedAt)
  `).run({ ...trade, executedAt: nowIso() })
}

export function getTrades(limit = 500, offset = 0) {
  return db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset)
}

export function getTradeStats() {
  const closed = db.prepare("SELECT * FROM trades WHERE pnl IS NOT NULL").all()
  const wins = closed.filter((t) => t.pnl > 0)
  const losses = closed.filter((t) => t.pnl <= 0)
  const grossWin = wins.reduce((sum, t) => sum + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0))
  return {
    totalTrades: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    avgPnlPct: closed.length ? closed.reduce((sum, t) => sum + (t.pnl_pct ?? 0), 0) / closed.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  }
}

// ── portfolio_snapshots ──
export function insertPortfolioSnapshot(snapshot) {
  db.prepare(`
    INSERT INTO portfolio_snapshots (total_value, cash_balance, open_positions_value, realized_pnl, unrealized_pnl, snapshot_at)
    VALUES (@totalValue, @cashBalance, @openPositionsValue, @realizedPnl, @unrealizedPnl, @snapshotAt)
  `).run({ ...snapshot, snapshotAt: nowIso() })
}

export function getLatestSnapshot() {
  return db.prepare('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT 1').get()
}

export function getSnapshotHistory(limit = 365) {
  return db.prepare('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?').all(limit)
}
