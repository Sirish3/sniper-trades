export function fmt(val) {
  return `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export function sign(val) {
  return val >= 0 ? `+${val.toFixed(1)}%` : `${val.toFixed(1)}%`
}
