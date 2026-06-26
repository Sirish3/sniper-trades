"""Volume confirmation calculations."""

VOLUME_WINDOW = 20


def calculate_volume_ratio(volume):
    """Return the latest volume as a multiple of its 20-day average.

    `volume` is a pandas Series of daily volume, oldest first. Returns 0
    if the 20-day average volume is zero.
    """
    avg_volume = volume.rolling(VOLUME_WINDOW).mean().iloc[-1]
    if avg_volume == 0:
        return 0.0

    return volume.iloc[-1] / avg_volume


def volume_label(ratio):
    """Classify a volume ratio into one of the volume confirmation labels."""
    if ratio < 0.8:
        return "VERY LOW — weak conviction"
    if ratio < 1.0:
        return "BELOW AVERAGE"
    if ratio < 1.2:
        return "AVERAGE"
    if ratio < 1.5:
        return "ABOVE AVERAGE"
    if ratio < 2.0:
        return "STRONG VOLUME"
    return "VOLUME SPIKE"
