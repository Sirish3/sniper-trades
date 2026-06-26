// Server-only constants. Position sizing, stop, and trim constants
// (RISK_PCT_BY_ENVIRONMENT, MAX_POSITION_PCT, MAX_SECTOR_PCT,
// MAX_OPEN_POSITIONS, ATR_STOP_MULT) already live in
// ../src/utils/positionPlan.js and are reused as-is — only the scan/alert
// thresholds that module doesn't cover live here.
import { getEnv } from './env.js'

export const PORTFOLIO_SIZE = Number(getEnv('PORTFOLIO_SIZE')) || 100000
export const VOL_RATIO_MIN = 1.5
export const RS_RANK_MIN = 70
export const CHASE_PCT_MAX = 7.0
export const HOT_SECTOR_PCT = -3.0
export const WARM_SECTOR_PCT = -8.0
export const ALERT_MIN_GRADE = getEnv('ALERT_MIN_GRADE') || 'A'
export const ALERT_MAX_PER_RUN = Number(getEnv('ALERT_MAX_PER_RUN')) || 5

export const GRADE_RANK = { 'A+': 4, A: 3, B: 2, C: 1 }

export function meetsMinGrade(grade, minGrade = ALERT_MIN_GRADE) {
  return (GRADE_RANK[grade] ?? 0) >= (GRADE_RANK[minGrade] ?? 0)
}
