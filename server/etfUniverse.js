// ETF universe for the sector-gate scan (Job 1) — broad market, the 11 SPDR
// sectors, industry-level, and thematic ETFs, each with a curated set of top
// holdings. Holdings drift over time (rebalances, index changes) — this is a
// reasonable snapshot for screening purposes, not a live constituents feed;
// refresh periodically the same way src/data/sp500.js is refreshed.
//
// Sector ETF tickers/names intentionally match SECTOR_ETF in
// ../src/utils/sectorRegime.js so sector-gate status and the existing
// per-stock sector regime check stay consistent.

export const BROAD_MARKET_ETFS = {
  SPY: { name: 'S&P 500', category: 'broad', holdings: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'AVGO', 'BRK.B', 'TSLA', 'JPM'] },
  QQQ: { name: 'Nasdaq-100', category: 'broad', holdings: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'AVGO', 'META', 'GOOGL', 'TSLA', 'COST', 'NFLX'] },
  IWM: { name: 'Russell 2000', category: 'broad', holdings: ['SMCI', 'MSTR', 'FTAI', 'SFM', 'ENSG', 'CVNA', 'VNOM', 'ALKS', 'RVMD', 'CRDO'] },
  DIA: { name: 'Dow Jones', category: 'broad', holdings: ['UNH', 'GS', 'MSFT', 'HD', 'CAT', 'AMGN', 'V', 'CRM', 'MCD', 'AXP'] },
}

export const SECTOR_ETFS = {
  XLK: { name: 'Technology', category: 'sector', holdings: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'CRM', 'ORCL', 'ADBE', 'AMD', 'CSCO', 'ACN'] },
  XLF: { name: 'Financials', category: 'sector', holdings: ['BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'SPGI', 'MS', 'AXP'] },
  XLV: { name: 'Healthcare', category: 'sector', holdings: ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'ISRG', 'PFE', 'DHR'] },
  XLE: { name: 'Energy', category: 'sector', holdings: ['XOM', 'CVX', 'COP', 'WMB', 'EOG', 'SLB', 'KMI', 'MPC', 'PSX', 'OXY'] },
  XLI: { name: 'Industrials', category: 'sector', holdings: ['GE', 'CAT', 'RTX', 'UBER', 'HON', 'UNP', 'BA', 'ADP', 'DE', 'ETN'] },
  XLY: { name: 'Consumer Discretionary', category: 'sector', holdings: ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG', 'TJX', 'LOW', 'SBUX', 'NKE', 'CMG'] },
  XLP: { name: 'Consumer Staples', category: 'sector', holdings: ['WMT', 'COST', 'PG', 'KO', 'PM', 'PEP', 'MDLZ', 'MO', 'CL', 'TGT'] },
  XLU: { name: 'Utilities', category: 'sector', holdings: ['NEE', 'SO', 'DUK', 'CEG', 'AEP', 'D', 'EXC', 'SRE', 'XEL', 'ED'] },
  XLRE: { name: 'Real Estate', category: 'sector', holdings: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'DLR', 'O', 'PSA', 'CCI', 'VICI'] },
  XLB: { name: 'Materials', category: 'sector', holdings: ['LIN', 'SHW', 'FCX', 'APD', 'ECL', 'NEM', 'CTVA', 'NUE', 'DOW', 'PPG'] },
  XLC: { name: 'Communications', category: 'sector', holdings: ['META', 'GOOGL', 'NFLX', 'TMUS', 'DIS', 'CMCSA', 'VZ', 'T', 'CHTR', 'EA'] },
}

export const INDUSTRY_ETFS = {
  SOXX: { name: 'Semiconductors', category: 'industry', holdings: ['NVDA', 'AVGO', 'AMD', 'QCOM', 'TXN', 'AMAT', 'LRCX', 'KLAC', 'ADI', 'MRVL', 'ON', 'NXPI', 'MCHP', 'MU', 'STX', 'WDC'] },
  SMH: { name: 'Semis (VanEck)', category: 'industry', holdings: ['NVDA', 'TSM', 'AVGO', 'AMD', 'QCOM', 'TXN', 'AMAT', 'LRCX', 'KLAC', 'ADI'] },
  IBB: { name: 'Biotech (large cap)', category: 'industry', holdings: ['AMGN', 'GILD', 'VRTX', 'REGN', 'BIIB', 'MRNA', 'ALNY', 'SGEN', 'INCY', 'BMRN'] },
  XBI: { name: 'Biotech (small cap)', category: 'industry', holdings: ['EXAS', 'RARE', 'CRSP', 'NTLA', 'BEAM', 'IONS', 'SRPT', 'ARWR', 'NBIX', 'HALO'] },
  XHB: { name: 'Homebuilders', category: 'industry', holdings: ['DHI', 'LEN', 'NVR', 'PHM', 'BLD', 'TOL', 'MAS', 'MHK', 'GRBK', 'TPH'] },
  ITB: { name: 'Home construction', category: 'industry', holdings: ['DHI', 'LEN', 'NVR', 'PHM', 'TOL', 'KBH', 'TPH', 'BLDR', 'MTH', 'CCS'] },
  KRE: { name: 'Regional banks', category: 'industry', holdings: ['FITB', 'MTB', 'HBAN', 'RF', 'CFG', 'KEY', 'ZION', 'CMA', 'PNFP', 'WTFC'] },
  KBE: { name: 'Banks (broad)', category: 'industry', holdings: ['JPM', 'BAC', 'WFC', 'C', 'USB', 'PNC', 'TFC', 'FITB', 'MTB', 'HBAN'] },
  XRT: { name: 'Retail', category: 'industry', holdings: ['AMZN', 'TJX', 'ROST', 'BBY', 'TGT', 'DG', 'DLTR', 'ULTA', 'GPS', 'M'] },
  XME: { name: 'Metals & Mining', category: 'industry', holdings: ['FCX', 'NUE', 'STLD', 'CLF', 'X', 'AA', 'MP', 'RS', 'CMC', 'ATI'] },
  OIH: { name: 'Oil services', category: 'industry', holdings: ['SLB', 'HAL', 'BKR', 'NOV', 'FTI', 'WFRD', 'CHX', 'RIG', 'VAL', 'TDW'] },
  GDX: { name: 'Gold miners', category: 'industry', holdings: ['NEM', 'AEM', 'GOLD', 'WPM', 'FNV', 'AU', 'KGC', 'GFI', 'PAAS', 'HMY'] },
  GDXJ: { name: 'Junior gold miners', category: 'industry', holdings: ['AEM', 'PAAS', 'HMY', 'BTG', 'EQX', 'OR', 'SSRM', 'CDE', 'IAG', 'DRD'] },
  XOP: { name: 'Oil & gas E&P', category: 'industry', holdings: ['FANG', 'EOG', 'COP', 'DVN', 'CTRA', 'OVV', 'MRO', 'APA', 'PR', 'CHRD'] },
  IHI: { name: 'Medical devices', category: 'industry', holdings: ['ABT', 'TMO', 'DHR', 'SYK', 'ISRG', 'BSX', 'MDT', 'BDX', 'EW', 'ZBH'] },
  XAR: { name: 'Aerospace & defense', category: 'industry', holdings: ['RTX', 'BA', 'GE', 'LMT', 'NOC', 'GD', 'TDG', 'HWM', 'LHX', 'AXON'] },
  PAVE: { name: 'Infrastructure', category: 'industry', holdings: ['ETN', 'PWR', 'URI', 'NUE', 'VMC', 'MLM', 'CAT', 'DE', 'EMR', 'JCI'] },
  MOO: { name: 'Agriculture', category: 'industry', holdings: ['DE', 'CTVA', 'NTR', 'ADM', 'MOS', 'BG', 'CF', 'FMC', 'AGCO', 'TSN'] },
  XHE: { name: 'Healthcare equipment', category: 'industry', holdings: ['BSX', 'SYK', 'ISRG', 'EW', 'ZBH', 'PODD', 'TFX', 'STE', 'RMD', 'NVCR'] },
}

export const THEMATIC_ETFS = {
  ARKK: { name: 'Disruptive innovation', category: 'thematic', holdings: ['TSLA', 'ROKU', 'COIN', 'SQ', 'PATH', 'RBLX', 'DKNG', 'CRSP', 'EXAS', 'TWLO'] },
  CIBR: { name: 'Cybersecurity', category: 'thematic', holdings: ['CRWD', 'PANW', 'FTNT', 'ZS', 'OKTA', 'CYBR', 'GEN', 'CHKP', 'S', 'NET'] },
  HACK: { name: 'Cybersecurity 2', category: 'thematic', holdings: ['PANW', 'CRWD', 'FTNT', 'CSCO', 'IBM', 'ZS', 'GEN', 'AKAM', 'CHKP', 'OKTA'] },
  CLOU: { name: 'Cloud computing', category: 'thematic', holdings: ['CRM', 'NOW', 'SNOW', 'DDOG', 'MDB', 'TEAM', 'WDAY', 'ZS', 'NET', 'CRWD'] },
  BOTZ: { name: 'Robotics & AI', category: 'thematic', holdings: ['NVDA', 'ABB', 'ISRG', 'FANUC', 'KEYENCE', 'YASKAWA', 'IRBT', 'OMRON', 'NTDOY', 'DXCM'] },
  FINX: { name: 'Fintech', category: 'thematic', holdings: ['SQ', 'PYPL', 'COIN', 'SOFI', 'AFRM', 'TOST', 'FOUR', 'MARA', 'UPST', 'FISV'] },
  JETS: { name: 'Airlines', category: 'thematic', holdings: ['DAL', 'UAL', 'LUV', 'AAL', 'ALK', 'RYAAY', 'JBLU', 'SAVE', 'HA', 'CPA'] },
  ICLN: { name: 'Clean energy', category: 'thematic', holdings: ['FSLR', 'ENPH', 'NEE', 'SEDG', 'RUN', 'PLUG', 'BE', 'CWEN', 'ORA', 'ARRY'] },
  BLOK: { name: 'Blockchain/crypto adjacent', category: 'thematic', holdings: ['COIN', 'MSTR', 'MARA', 'RIOT', 'SQ', 'PYPL', 'HUT', 'CLSK', 'GLXY', 'BITF'] },
  MOON: { name: 'Space exploration', category: 'thematic', holdings: ['RKLB', 'LMT', 'NOC', 'BA', 'IRDM', 'ASTS', 'VSAT', 'TDY', 'HEI', 'KTOS'] },
  METV: { name: 'Metaverse', category: 'thematic', holdings: ['META', 'NVDA', 'MSFT', 'RBLX', 'U', 'SNAP', 'TTWO', 'EA', 'SONY', 'AAPL'] },
  ROBO: { name: 'Robotics 2', category: 'thematic', holdings: ['INTU', 'ZBRA', 'ROK', 'IPGP', 'CGNX', 'TER', 'NVDA', 'ABB', 'KEYS', 'NDSN'] },
}

export const ALL_ETFS = { ...BROAD_MARKET_ETFS, ...SECTOR_ETFS, ...INDUSTRY_ETFS, ...THEMATIC_ETFS }

// Always scanned regardless of sector/ETF status.
export const PERMANENT_WATCHLIST = [
  'MU', 'SNDK', 'STX', 'WDC', 'ON', 'NXPI', 'NVDA', 'AMD', 'AVGO',
  'QCOM', 'CRWD', 'PANW', 'AXON', 'DDOG', 'MELI', 'SHOP', 'SQ', 'COIN',
  'TSLA', 'META', 'GOOGL', 'AMZN', 'MSFT', 'AAPL', 'ARM', 'SMCI',
]

// Builds the {symbol, name, sector}-shaped "company" list used by the
// existing scanUniverse/evaluate* functions in src/utils, for one ETF's
// holdings. `name` falls back to the ticker itself — we don't carry full
// company names for every constituent, only sector/category for grouping.
export function getEtfConstituents(etfTicker) {
  const etf = ALL_ETFS[etfTicker]
  if (!etf) return []
  return etf.holdings.map((symbol) => ({ symbol, name: symbol, sector: etf.name }))
}

// All ETF tickers, grouped by category, for the sector-gate scan.
export function getAllEtfTickers() {
  return Object.keys(ALL_ETFS)
}
