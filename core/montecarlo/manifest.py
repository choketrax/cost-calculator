import hashlib
import json
from datetime import datetime
import uuid
from .models import SimulationManifest, DistributionSpec, PRNG_ALGORITHM, PRNG_VERSION, NUMPY_VERSION

def hash_dict(d: dict) -> str:
    """Deterministic SHA-256 hash of a dict.
    Uses sort_keys=True and compact separators for canonical form.
    Financial values stored as strings to avoid float precision issues.
    """
    canonical = json.dumps(d, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()

def hash_file_bytes(data: bytes) -> str:
    """SHA-256 hash of raw bytes."""
    return hashlib.sha256(data).hexdigest()

def create_manifest(
    audit_id: str,
    seed: int,
    distribution_specs: list[DistributionSpec],
    parameters: dict,
    n_iterations: int,
    pricing_dataset_version: int,
    input_hash: str,
    scenario_hash: str,
    application_version: str = "0.1.0"
) -> SimulationManifest:
    """Create a new simulation manifest."""
    sim_id = str(uuid.uuid4())
    
    dist_defs = [
        {
            "variable_name": spec.variable_name,
            "distribution": spec.distribution,
            "params": spec.params
        }
        for spec in distribution_specs
    ]
    
    return SimulationManifest(
        simulation_id=sim_id,
        audit_id=audit_id,
        seed=seed,
        prng_algorithm=PRNG_ALGORITHM,
        prng_version=PRNG_VERSION,
        numpy_version=NUMPY_VERSION,
        application_version=application_version,
        pricing_dataset_version=pricing_dataset_version,
        distribution_definitions=dist_defs,
        parameters=parameters,
        iteration_count=n_iterations,
        input_hash=input_hash,
        scenario_hash=scenario_hash,
        timestamp=datetime.utcnow(),
        results_hash="" # Computed after
    )
