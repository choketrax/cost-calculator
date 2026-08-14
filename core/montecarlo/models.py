from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime
import numpy as np

# PRNG constants
PRNG_ALGORITHM = "numpy-pcg64"
PRNG_VERSION = "1"
NUMPY_VERSION = np.__version__

class DistributionSpec(BaseModel):
    variable_name: str
    distribution: str
    params: Dict[str, Any]

class SimulationManifest(BaseModel):
    simulation_id: str
    audit_id: str
    seed: int
    prng_algorithm: str
    prng_version: str
    numpy_version: str
    application_version: str
    pricing_dataset_version: int
    distribution_definitions: List[Dict[str, Any]]
    parameters: Dict[str, Any]
    iteration_count: int
    input_hash: str
    scenario_hash: str
    timestamp: datetime
    results_hash: str

class SimulationStats(BaseModel):
    mean: float
    median: float
    std_dev: float
    p5: float
    p10: float
    p25: float
    p50: float
    p75: float
    p90: float
    p95: float
    minimum: float
    maximum: float
    prob_savings_positive: float
    prob_savings_gt_target: float
    iteration_count: int

class SimulationResult(BaseModel):
    manifest: SimulationManifest
    baseline_stats: SimulationStats
    optimized_stats: SimulationStats
    monthly_savings_stats: SimulationStats
    annual_savings_stats: SimulationStats
    pct_savings_stats: SimulationStats
    raw_monthly_savings: Optional[List[float]]
