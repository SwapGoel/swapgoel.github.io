import numpy as np
from scipy.signal import find_peaks

def pick_three_points(x, y, db_drop=3):
    """
    Identify three key points on a sync curve:
    1. First intersection with the -db_drop dB line (first 3 dB crossing).
    2. Last intersection with the -db_drop dB line (last 3 dB crossing).
    3. Second lobe peak: choose the lower-amplitude side lobe (left or right) to maximize PSLR.

    Parameters:
        x (array-like): Independent variable (e.g., range or time).
        y (array-like): Dependent variable (curve magnitude, same units as dB or linear).
        db_drop (float): dB drop from the main peak defining the half-power (-3 dB) level.

    Returns:
        tuple: (x_first, x_last, x_sidelobe), x-values of the three points.
    """
    # Convert to numpy arrays
    x = np.asarray(x)
    y = np.asarray(y)

    # Determine threshold: half-power level
    # If y is in linear scale, threshold = max(y)/sqrt(2)
    # If y is in dB, threshold = max(y) - db_drop
    if np.any(y > 20):  # heuristic: values >20 likely in dB
        threshold = np.max(y) - db_drop
    else:
        threshold = np.max(y) / np.sqrt(2)

    # Find crossing points by sign change of (y - threshold)
    sign = np.sign(y - threshold)
    crossings = np.where(sign[:-1] * sign[1:] < 0)[0]

    if len(crossings) < 2:
        raise ValueError("Less than two crossings detected with 3 dB threshold.")

    # First and last crossing indices
    i1 = crossings[0]
    i2 = crossings[-1]

    # Linear interpolation to get more accurate crossing x-values
    def interp_zero(i):
        x0, x1 = x[i], x[i+1]
        y0, y1 = y[i] - threshold, y[i+1] - threshold
        return x0 - y0 * (x1 - x0) / (y1 - y0)

    x_first = interp_zero(i1)
    x_last = interp_zero(i2)

    # Identify peaks (local maxima)
    peaks, _ = find_peaks(y)
    main_idx = np.argmax(y)

    # Side lobe peaks on each side of main
    left_peaks = peaks[peaks < main_idx]
    right_peaks = peaks[peaks > main_idx]

    if left_peaks.size == 0 or right_peaks.size == 0:
        raise ValueError("Unable to find side lobes on both sides of main peak.")

    # Pick the lobe peaks closest to main on each side
    left_lobe_idx = left_peaks[-1]
    right_lobe_idx = right_peaks[0]

    # Choose the lower amplitude lobe to maximize PSLR
    if y[left_lobe_idx] < y[right_lobe_idx]:
        x_sidelobe = x[left_lobe_idx]
    else:
        x_sidelobe = x[right_lobe_idx]

    return x_first, x_last, x_sidelobe

# Example usage:
x = np.linspace(-10, 10, 1001)
y = np.sinc(x) ** 2
x_first, x_last, x_sidelobe = pick_three_points(x, y)
print(f"3dB Start: {x_first}, 3dB End: {x_last}, Side Lobe: {x_sidelobe}")