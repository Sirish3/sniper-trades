"""MACD (line, signal, histogram) and a simple buy/sell read."""


def calculate_macd(close):
    """Compute the current MACD line, signal line, and histogram.

    `close` is a pandas Series of closing prices, oldest first.
    """
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal = macd_line.ewm(span=9, adjust=False).mean()
    histogram = macd_line - signal

    return {
        "macd_now": macd_line.iloc[-1],
        "signal_now": signal.iloc[-1],
        "hist_now": histogram.iloc[-1],
    }


def macd_signal_label(macd_now, signal_now):
    """'BUY' if the MACD line is above its signal line, else 'SELL'."""
    return "BUY" if macd_now > signal_now else "SELL"
