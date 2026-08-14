import numpy as np
from typing import Optional
from decimal import Decimal
from .models import SimulationStats

def compute_simulation_stats(
    values: np.ndarray,
    target: float = 0.0,
    implementation_cost: float = 0.0,
) -> SimulationStats:
    """Compute complete statistics for a simulation output array.
    Handles edge cases: empty array, all-zero array, NaN values.
    """
    if len(values) == 0:
        return SimulationStats(
            mean=0.0, median=0.0, std_dev=0.0, p5=0.0, p10=0.0,
            p25=0.0, p50=0.0, p75=0.0, p90=0.0, p95=0.0,
            minimum=0.0, maximum=0.0, prob_savings_positive=0.0,
            prob_savings_gt_target=0.0, iteration_count=0
        )
        
    # Ignore NaNs
    valid_values = values[~np.isnan(values)]
    if len(valid_values) == 0:
        return SimulationStats(
            mean=0.0, median=0.0, std_dev=0.0, p5=0.0, p10=0.0,
            p25=0.0, p50=0.0, p75=0.0, p90=0.0, p95=0.0,
            minimum=0.0, maximum=0.0, prob_savings_positive=0.0,
            prob_savings_gt_target=0.0, iteration_count=len(values)
        )
        
    return SimulationStats(
        mean=float(np.mean(valid_values)),
        median=float(np.median(valid_values)),
        std_dev=float(np.std(valid_values)),
        p5=float(np.percentile(valid_values, 5)),
        p10=float(np.percentile(valid_values, 10)),
        p25=float(np.percentile(valid_values, 25)),
        p50=float(np.percentile(valid_values, 50)),
        p75=float(np.percentile(valid_values, 75)),
        p90=float(np.percentile(valid_values, 90)),
        p95=float(np.percentile(valid_values, 95)),
        minimum=float(np.min(valid_values)),
        maximum=float(np.max(valid_values)),
        prob_savings_positive=float(np.mean(valid_values > 0)),
        prob_savings_gt_target=float(np.mean(valid_values > target)),
        iteration_count=len(values),
    )

def format_stats_summary(stats: SimulationStats, label: str = "") -> str:
    """Format stats as human-readable text for reports."""
    title = f"--- {label} Statistics ---" if label else "--- Statistics ---"
    lines = [
        title,
        f"Mean:     {stats.mean:10.2f}",
        f"Median:   {stats.median:10.2f}",
        f"Std Dev:  {stats.std_dev:10.2f}",
        f"Min:      {stats.minimum:10.2f}",
        f"Max:      {stats.maximum:10.2f}",
        "Percentiles:",
        f"  p5:   {stats.p5:10.2f}",
        f"  p25:  {stats.p25:10.2f}",
        f"  p75:  {stats.p75:10.2f}",
        f"  p95:  {stats.p95:10.2f}",
        f"P(>0):      {stats.prob_savings_positive*100:.1f}%",
        f"P(>Target): {stats.prob_savings_gt_target*100:.1f}%",
        f"Iterations: {stats.iteration_count}"
    ]
    return "\\n".join(lines)
