import hashlib
import numpy as np
from decimal import Decimal
from typing import Optional, List, Dict
from datetime import datetime

from .models import (
    DistributionSpec, SimulationManifest, SimulationStats, SimulationResult
)
from .stats import compute_simulation_stats
from .manifest import create_manifest
import sys
import os

# Ensure we can import the RNG from core.prng
try:
    from core.prng.rng import DeterministicRNG
except ImportError:
    # Fallback to appending to sys.path
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))
    from core.prng.rng import DeterministicRNG

class MonteCarloEngine:
    """Deterministic Monte Carlo simulation engine."""
    
    SUPPORTED_ITERATIONS = {100, 500, 1_000, 10_000}
    DEFAULT_ITERATIONS = 10_000
    
    def __init__(self, pricing_registry, application_version: str = "0.1.0"):
        self.pricing_registry = pricing_registry
        self.application_version = application_version
    
    def run(
        self,
        audit_id: str,
        seed: int,
        distribution_specs: List[DistributionSpec],
        baseline_monthly_cost: Decimal,
        pricing_dataset_version: int,
        input_hash: str,
        scenario_hash: str,
        pricing_info: Dict[str, float] = None,
        n_iterations: int = 10_000,
        savings_target: Decimal = Decimal("0"),
        implementation_cost: Decimal = Decimal("0"),
    ) -> SimulationResult:
        if n_iterations not in self.SUPPORTED_ITERATIONS:
            raise ValueError(f"n_iterations must be one of {self.SUPPORTED_ITERATIONS}")
            
        rng = DeterministicRNG(seed)
        
        pricing_info = pricing_info or {}
        
        # Manifest
        manifest = create_manifest(
            audit_id=audit_id,
            seed=seed,
            distribution_specs=distribution_specs,
            parameters=pricing_info,
            n_iterations=n_iterations,
            pricing_dataset_version=pricing_dataset_version,
            input_hash=input_hash,
            scenario_hash=scenario_hash,
            application_version=self.application_version
        )
        
        # Generate samples
        samples = self._generate_samples(rng, distribution_specs, n_iterations)
        
        # Compute costs
        baseline_costs, optimized_costs = self._compute_costs_vectorized(
            baseline_cost=baseline_monthly_cost,
            samples=samples,
            pricing_info=pricing_info,
            n=n_iterations
        )
        
        monthly_savings = baseline_costs - optimized_costs
        annual_savings = monthly_savings * 12
        pct_savings = np.zeros_like(monthly_savings)
        valid_idx = baseline_costs > 0
        pct_savings[valid_idx] = (monthly_savings[valid_idx] / baseline_costs[valid_idx]) * 100
        
        # Hash results
        manifest.results_hash = self._hash_results(monthly_savings)
        
        # Convert targets
        target_f = float(savings_target)
        impl_cost_f = float(implementation_cost)
        
        # Stats
        b_stats = compute_simulation_stats(baseline_costs)
        o_stats = compute_simulation_stats(optimized_costs)
        m_stats = compute_simulation_stats(monthly_savings, target_f, impl_cost_f)
        a_stats = compute_simulation_stats(annual_savings, target_f * 12, impl_cost_f)
        p_stats = compute_simulation_stats(pct_savings)
        
        return SimulationResult(
            manifest=manifest,
            baseline_stats=b_stats,
            optimized_stats=o_stats,
            monthly_savings_stats=m_stats,
            annual_savings_stats=a_stats,
            pct_savings_stats=p_stats,
            raw_monthly_savings=monthly_savings.tolist()
        )
        
    def _generate_samples(self, rng: DeterministicRNG, specs: List[DistributionSpec], n: int) -> Dict[str, np.ndarray]:
        """Generate all random samples upfront. Returns {variable_name: array(n,)}."""
        # Default fixed medians if not present
        default_medians = {
            "request_volume": 1_000_000.0,
            "input_tokens_per_request": 1000.0,
            "output_tokens_per_request": 200.0,
            "cache_hit_rate": 0.0,
            "routing_cheap_fraction": 0.0,
            "retry_rate": 0.0,
            "failure_rate": 0.0,
            "workload_growth": 1.0,
            "context_reduction": 0.0,
        }
        
        samples = {}
        spec_dict = {s.variable_name: s for s in specs}
        
        for var_name, default_val in default_medians.items():
            if var_name in spec_dict:
                spec = spec_dict[var_name]
                samples[var_name] = rng.sample(spec.distribution, spec.params, n)
            else:
                samples[var_name] = np.full(n, default_val, dtype=np.float64)
                
        return samples

    def _compute_costs_vectorized(
        self,
        baseline_cost: Decimal,
        samples: Dict[str, np.ndarray],
        pricing_info: Dict[str, float],
        n: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Compute baseline and optimized costs for all iterations vectorized."""
        base_cost_f = float(baseline_cost)
        
        # pricing info extraction
        baseline_input_price = pricing_info.get("baseline_input_price", 0.0)
        baseline_output_price = pricing_info.get("baseline_output_price", 0.0)
        
        opt_input_price = pricing_info.get("opt_input_price", baseline_input_price)
        opt_output_price = pricing_info.get("opt_output_price", baseline_output_price)
        opt_cached_price = pricing_info.get("opt_cached_price", opt_input_price * 0.5)
        cheap_model_input_price = pricing_info.get("cheap_model_input_price", opt_input_price)
        cheap_model_output_price = pricing_info.get("cheap_model_output_price", opt_output_price)
        
        vol = samples["request_volume"] * samples["workload_growth"]
        in_tok = samples["input_tokens_per_request"]
        out_tok = samples["output_tokens_per_request"]
        
        baseline_costs = vol * (in_tok * baseline_input_price + out_tok * baseline_output_price) / 1000.0
        
        if np.all(baseline_costs == 0) and base_cost_f > 0:
            baseline_costs = np.full(n, base_cost_f, dtype=np.float64) * samples["workload_growth"]
            
        effective_in_tok = in_tok * (1.0 - samples["context_reduction"])
        
        uncached_in_tok = effective_in_tok * (1.0 - samples["cache_hit_rate"])
        cached_in_tok = effective_in_tok * samples["cache_hit_rate"]
        
        main_model_cost = (uncached_in_tok * opt_input_price + cached_in_tok * opt_cached_price + out_tok * opt_output_price) / 1000.0
        cheap_model_cost = (uncached_in_tok * cheap_model_input_price + cached_in_tok * cheap_model_input_price * 0.5 + out_tok * cheap_model_output_price) / 1000.0
        
        avg_req_cost = main_model_cost * (1.0 - samples["routing_cheap_fraction"]) + cheap_model_cost * samples["routing_cheap_fraction"]
        
        effective_vol = vol * (1.0 + samples["retry_rate"] + samples["failure_rate"])
        
        optimized_costs = effective_vol * avg_req_cost
        
        return baseline_costs, optimized_costs
        
    def _hash_results(self, monthly_savings: np.ndarray) -> str:
        """SHA-256 hash of simulation results array for integrity verification."""
        return hashlib.sha256(monthly_savings.tobytes()).hexdigest()
        
    def replay(
        self,
        manifest: SimulationManifest,
        baseline_monthly_cost: Decimal,
        savings_target: Decimal = Decimal("0"),
        pricing_info: Dict[str, float] = None
    ) -> SimulationResult:
        
        p_info = pricing_info or manifest.parameters
        
        rng = DeterministicRNG(manifest.seed)
        
        specs = [DistributionSpec(**d) for d in manifest.distribution_definitions]
        samples = self._generate_samples(rng, specs, manifest.iteration_count)
        
        baseline_costs, optimized_costs = self._compute_costs_vectorized(
            baseline_cost=baseline_monthly_cost,
            samples=samples,
            pricing_info=p_info,
            n=manifest.iteration_count
        )
        
        monthly_savings = baseline_costs - optimized_costs
        
        calculated_hash = self._hash_results(monthly_savings)
        if calculated_hash != manifest.results_hash:
            raise ValueError("Replay hash mismatch: Results are not identical to original simulation")
            
        annual_savings = monthly_savings * 12
        pct_savings = np.zeros_like(monthly_savings)
        valid_idx = baseline_costs > 0
        pct_savings[valid_idx] = (monthly_savings[valid_idx] / baseline_costs[valid_idx]) * 100
        
        target_f = float(savings_target)
        
        b_stats = compute_simulation_stats(baseline_costs)
        o_stats = compute_simulation_stats(optimized_costs)
        m_stats = compute_simulation_stats(monthly_savings, target_f)
        a_stats = compute_simulation_stats(annual_savings, target_f * 12)
        p_stats = compute_simulation_stats(pct_savings)
        
        return SimulationResult(
            manifest=manifest,
            baseline_stats=b_stats,
            optimized_stats=o_stats,
            monthly_savings_stats=m_stats,
            annual_savings_stats=a_stats,
            pct_savings_stats=p_stats,
            raw_monthly_savings=monthly_savings.tolist()
        )
