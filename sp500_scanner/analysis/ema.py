"""EMA (Exponential Moving Average) calculations."""


def calculate_emas(close):
    """Compute EMA 10/20/50 plus the previous-bar EMA 10/20 values.

    `close` is a pandas Series of closing prices, oldest first. The
    previous-bar EMA 10/20 values are needed for fresh-cross detection.
    """
    ema10 = close.ewm(span=10, adjust=False).mean()
    ema20 = close.ewm(span=20, adjust=False).mean()
    ema50 = close.ewm(span=50, adjust=False).mean()

    return {
        "ema10": ema10.iloc[-1],
        "ema20": ema20.iloc[-1],
        "ema50": ema50.iloc[-1],
        "ema10_prev": ema10.iloc[-2],
        "ema20_prev": ema20.iloc[-2],
    }
