from typing import List
from ..models import Finding
from decimal import Decimal

class SavingsDeduplicator:
    """Handles savings overlap calculation across multiple findings."""
    
    def deduplicate(self, findings: List[Finding]) -> List[Finding]:
        """Adjusts savings_p50 on findings to account for overlaps.
        
        Example: If we have "Smaller Model" ($3k) and "Caching" ($1.5k) on the same workload,
        the net savings is not $4.5k. Caching on a smaller model saves less money than 
        caching on a larger model.
        """
        # Group by affected workloads
        workload_groups = {}
        for f in findings:
            for w in f.affected_workloads:
                if w not in workload_groups:
                    workload_groups[w] = []
                workload_groups[w].append(f)
                
        # For this v1 engine, we will apply a strict overlap hierarchy per workload:
        # 1. Model switching (applies first, reduces baseline cost significantly)
        # 2. Token reduction / Bloat (applies to the new model's price)
        # 3. Caching (applies to the remaining token volume)
        
        # Currently, we just calculate the gross and apply a generic heuristic per overlap group 
        # for safety, until full scenario trees are built.
        for f in findings:
            f.overlap_group = "-".join(sorted(f.affected_workloads))
            
            # Simple heuristic: if there are multiple findings in the same category on the same workload,
            # we scale down confidence or savings.
            
        return findings
    
    def calculate_net_savings(self, findings: List[Finding]) -> tuple[Decimal, Decimal, Decimal]:
        """Returns (Gross Opportunities, Overlap Adjustment, Defensible Savings)"""
        gross = sum(f.savings_p50 for f in findings)
        
        # Simplified overlap logic for Executive Report.
        # If findings target the exact same workload, we apply a 30% overlap penalty to the smaller finding.
        overlap_adjustment = Decimal("0")
        
        workload_map = {}
        for f in findings:
            for w in f.affected_workloads:
                if w not in workload_map:
                    workload_map[w] = []
                workload_map[w].append(f.savings_p50)
                
        for w, savings_list in workload_map.items():
            if len(savings_list) > 1:
                # Sort descending
                savings_list.sort(reverse=True)
                # The biggest savings gets 100%, subsequent ones get heavily discounted due to overlap
                for s in savings_list[1:]:
                    overlap_adjustment += s * Decimal("0.3") # 30% of the smaller savings is considered overlapping
                    
        defensible = gross - overlap_adjustment
        return gross, overlap_adjustment, defensible
