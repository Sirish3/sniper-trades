"""RSI (Relative Strength Index) calculation."""

RSI_PERIOD = 14


def calculate_rsi(close):
    """Compute the latest 14-period RSI value.

    `close` is a pandas Series of closing prices, oldest first. Returns
    50 (neutral) if the average loss is zero, avoiding a division by zero.
    """
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(RSI_PERIOD).mean()
    loss = (-delta.clip(upper=0)).rolling(RSI_PERIOD).mean()

    avg_gain = gain.iloc[-1]
    avg_loss = loss.iloc[-1]

    if avg_loss == 0:
        return 50.0

    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def rsi_zone(rsi_value):
    """Classify an RSI value into one of the buy-zone labels."""
    if rsi_value < 30:
        return "OVERSOLD"
    if rsi_value < 40:
        return "WEAK"
    if rsi_value <= 63:
        return "BUY ZONE"
    if rsi_value <= 70:
        return "GETTING HOT"
    return "OVERBOUGHT"
