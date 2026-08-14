"""
Deterministic PRNG module using NumPy PCG64.

All simulations must be bit-for-bit reproducible given the same seed and
numpy version. We pin numpy~=2.1 and record the version in each simulation
manifest. The PCG64 algorithm is documented to be stable within numpy 2.x.
"""
from __future__ import annotations

import numpy as np

# Constants recorded in SimulationManifest for audit reproducibility
PRNG_ALGORITHM = "numpy-pcg64"
PRNG_VERSION = "1"  # Increment if we change algorithm or parameter conventions
NUMPY_VERSION = np.__version__


class PRNGError(Exception):
    """Raised when PRNG configuration or parameters are invalid."""


class DeterministicRNG:
    """
    Deterministic random number generator backed by NumPy PCG64.

    Usage:
        rng = DeterministicRNG(seed=42)
        samples = rng.sample("pert", {"low": 0, "mode": 0.2, "high": 0.4}, n=10_000)

    The internal state can be saved and restored for replay:
        state = rng.get_state()
        rng2 = DeterministicRNG.from_state(state)
    """

    def __init__(self, seed: int):
        if not isinstance(seed, int) or seed < 0:
            raise PRNGError(f"Seed must be a non-negative integer, got {seed!r}")
        self._seed = seed
        self._rng = np.random.Generator(np.random.PCG64(seed))

    @classmethod
    def from_state(cls, state: dict) -> "DeterministicRNG":
        """Restore a RNG from a saved state dict."""
        obj = cls.__new__(cls)
        obj._seed = state["seed"]
        obj._rng = np.random.Generator(np.random.PCG64())
        obj._rng.bit_generator.state = state["bit_generator_state"]
        return obj

    def get_state(self) -> dict:
        """Save the current RNG state for audit replay."""
        return {
            "seed": self._seed,
            "prng_algorithm": PRNG_ALGORITHM,
            "numpy_version": NUMPY_VERSION,
            "bit_generator_state": self._rng.bit_generator.state,
        }

    def uniform(self, low: float, high: float, size: int) -> np.ndarray:
        return self._rng.uniform(low, high, size)

    def normal(self, mu: float, sigma: float, size: int) -> np.ndarray:
        return self._rng.normal(mu, sigma, size)

    def triangular(self, a: float, c: float, b: float, size: int) -> np.ndarray:
        """Triangular distribution with left=a, mode=c, right=b."""
        return self._rng.triangular(a, c, b, size)

    def beta_pert(
        self,
        low: float,
        mode: float,
        high: float,
        lam: float = 4.0,
        size: int = None,
    ) -> np.ndarray:
        """
        PERT (Program Evaluation and Review Technique) distribution via Beta.

        Mean = (low + lam*mode + high) / (lam + 2)
        """
        if not (low <= mode <= high):
            raise PRNGError(f"PERT requires low <= mode <= high, got {low}, {mode}, {high}")
        if low == high:
            return np.full(size, low, dtype=np.float64)
        alpha = 1.0 + lam * (mode - low) / (high - low)
        beta_param = 1.0 + lam * (high - mode) / (high - low)
        return low + (high - low) * self._rng.beta(alpha, beta_param, size)

    def lognormal(self, mu: float, sigma: float, size: int) -> np.ndarray:
        return self._rng.lognormal(mu, sigma, size)

    def bernoulli(self, p: float, size: int) -> np.ndarray:
        return self._rng.binomial(1, p, size).astype(np.float64)

    def weighted_choice(self, options: list, weights: list, size: int) -> np.ndarray:
        prob = np.array(weights, dtype=np.float64)
        prob /= prob.sum()
        return self._rng.choice(options, size=size, p=prob)

    def sample(self, distribution: str, params: dict, size: int) -> np.ndarray:
        """
        Generate `size` random samples from the named distribution.

        Supported distributions and required params:
          - "uniform": {low, high}
          - "normal": {mu, sigma}
          - "triangular": {a, c, b}  (left, mode, right)
          - "beta_pert" | "pert": {low, mode, high} [, lam=4.0]
          - "lognormal": {mu, sigma}
          - "bernoulli": {p}
          - "weighted_choice": {options, weights}
        """
        dist = distribution.lower()
        try:
            if dist == "uniform":
                return self.uniform(params["low"], params["high"], size)
            elif dist == "normal":
                return self.normal(params["mu"], params["sigma"], size)
            elif dist == "triangular":
                return self.triangular(params["a"], params["c"], params["b"], size)
            elif dist in ("beta_pert", "pert"):
                # Support both key conventions
                low = params.get("low", params.get("a"))
                mode = params.get("mode", params.get("m"))
                high = params.get("high", params.get("b"))
                lam = params.get("lam", 4.0)
                return self.beta_pert(low, mode, high, lam=lam, size=size)
            elif dist == "lognormal":
                return self.lognormal(params["mu"], params["sigma"], size)
            elif dist == "bernoulli":
                return self.bernoulli(params["p"], size)
            elif dist == "weighted_choice":
                return self.weighted_choice(params["options"], params["weights"], size)
            else:
                raise PRNGError(f"Unknown distribution: {distribution!r}")
        except KeyError as e:
            raise PRNGError(f"Missing parameter {e} for distribution {distribution!r}") from e


# ---------------------------------------------------------------------------
# Utility functions (exported for manifest hashing)
# ---------------------------------------------------------------------------

def pert_expected_value(low: float, mode: float, high: float, lam: float = 4.0) -> float:
    """E[X] of the PERT distribution."""
    return (low + lam * mode + high) / (lam + 2)


def pert_variance(low: float, mode: float, high: float, lam: float = 4.0) -> float:
    """Var[X] of the PERT distribution (approximation)."""
    mean = pert_expected_value(low, mode, high, lam)
    return ((high - low) ** 2) / ((lam + 2) ** 2 * (lam + 3) / (lam + 2))
