"""
Executive AI Cost Savings Report Generator.

Converts audit findings, usage records, and Monte Carlo simulation results into
a professional HTML report and a structured JSON report.

Design principles:
- Financial numbers are sourced from Decimal calculations, never LLM output.
- The LLM (if enabled) contributes narrative text only, never computed values.
- The HTML report is standalone (no external CDN dependencies).
"""
from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from core.models import Audit, Finding, SimulationManifest, UsageRecord
from core.pricing.registry import PricingRegistry
from core.pricing.calculator import CostCalculator


# ---------------------------------------------------------------------------
# HTML template — standalone, no CDN
# ---------------------------------------------------------------------------

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Cost Savings Report — {customer_name}</title>
  <style>
    :root {{
      --bg: #0f1117; --surface: #1a1d2e; --card: #252840;
      --accent: #6366f1; --accent2: #10b981; --warn: #f59e0b;
      --danger: #ef4444; --text: #e2e8f0; --muted: #94a3b8;
      --border: #2d3148;
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg); color: var(--text); line-height: 1.6; }}
    .wrapper {{ max-width: 1100px; margin: 0 auto; padding: 40px 24px; }}

    /* Header */
    .header {{ background: linear-gradient(135deg, var(--accent), #8b5cf6);
               border-radius: 16px; padding: 40px; margin-bottom: 32px; }}
    .header h1 {{ font-size: 2rem; font-weight: 700; color: #fff; }}
    .header .sub {{ color: rgba(255,255,255,0.75); font-size: 0.95rem; margin-top: 8px; }}
    .header .meta {{ display: flex; gap: 32px; margin-top: 24px; flex-wrap: wrap; }}
    .header .meta-item {{ text-align: center; }}
    .header .meta-item .value {{ font-size: 1.75rem; font-weight: 700; color: #fff; }}
    .header .meta-item .label {{ font-size: 0.8rem; color: rgba(255,255,255,0.7); text-transform: uppercase; }}

    /* Cards */
    .card {{ background: var(--card); border: 1px solid var(--border);
             border-radius: 12px; padding: 24px; margin-bottom: 24px; }}
    .card h2 {{ font-size: 1.15rem; font-weight: 600; color: var(--accent); margin-bottom: 16px; }}
    .card h3 {{ font-size: 0.95rem; font-weight: 600; margin-bottom: 8px; color: var(--text); }}

    /* Savings highlight */
    .savings-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }}
    .savings-stat {{ background: var(--surface); border-radius: 10px; padding: 20px; text-align: center; }}
    .savings-stat .value {{ font-size: 2rem; font-weight: 700; color: var(--accent2); }}
    .savings-stat .label {{ font-size: 0.8rem; color: var(--muted); margin-top: 4px; text-transform: uppercase; }}
    .savings-stat .conf {{ font-size: 0.75rem; color: var(--warn); margin-top: 2px; }}

    /* Findings table */
    table {{ width: 100%; border-collapse: collapse; font-size: 0.88rem; }}
    th {{ text-align: left; padding: 10px 12px; font-size: 0.75rem; text-transform: uppercase;
          color: var(--muted); border-bottom: 1px solid var(--border); }}
    td {{ padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }}
    tr:last-child td {{ border-bottom: none; }}
    tr:hover td {{ background: rgba(99,102,241,0.05); }}

    /* Badges */
    .badge {{ display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; }}
    .badge-high {{ background: rgba(239,68,68,0.15); color: #fca5a5; }}
    .badge-medium {{ background: rgba(245,158,11,0.15); color: #fcd34d; }}
    .badge-low {{ background: rgba(99,102,241,0.15); color: #a5b4fc; }}
    .badge-ok {{ background: rgba(16,185,129,0.15); color: #6ee7b7; }}

    /* Cost table */
    .cost-bar {{ background: var(--border); border-radius: 4px; height: 6px; margin-top: 4px; }}
    .cost-bar-fill {{ height: 100%; border-radius: 4px; background: var(--accent); }}

    /* Footer */
    .footer {{ margin-top: 48px; text-align: center; color: var(--muted); font-size: 0.8rem; }}
    .footer strong {{ color: var(--text); }}

    /* Confidence intervals */
    .ci-box {{ background: var(--surface); border-radius: 8px; padding: 12px 16px; margin-top: 12px; }}
    .ci-row {{ display: flex; justify-content: space-between; padding: 4px 0; }}
    .ci-label {{ color: var(--muted); font-size: 0.82rem; }}
    .ci-value {{ font-weight: 600; color: var(--text); font-size: 0.82rem; }}

    @media (max-width: 600px) {{
      .header .meta {{ gap: 16px; }}
      .header .meta-item .value {{ font-size: 1.25rem; }}
    }}
  </style>
</head>
<body>
  <div class="wrapper">

    <!-- Header -->
    <div class="header">
      <h1>AI Cost Savings Report</h1>
      <div class="sub">{customer_name} &bull; {period_start} to {period_end} &bull; Generated {generated_at}</div>
      <div class="meta">
        <div class="meta-item">
          <div class="value">${baseline_monthly:,.0f}</div>
          <div class="label">Monthly Baseline</div>
        </div>
        <div class="meta-item">
          <div class="value">${savings_p50_monthly:,.0f}</div>
          <div class="label">Est. Monthly Savings</div>
        </div>
        <div class="meta-item">
          <div class="value">{pct_savings:.0f}%</div>
          <div class="label">Savings Rate</div>
        </div>
        <div class="meta-item">
          <div class="value">{findings_count}</div>
          <div class="label">Findings</div>
        </div>
      </div>
    </div>

    <!-- Monte Carlo Summary -->
    {simulation_section}

    <!-- Findings -->
    <div class="card">
      <h2>&#128269; Waste Findings</h2>
      {findings_table}
    </div>

    <!-- Cost Breakdown -->
    <div class="card">
      <h2>&#128200; Cost Breakdown by Model</h2>
      {cost_breakdown_table}
    </div>

    <!-- Disclaimer -->
    <div class="card" style="border-color: var(--warn);">
      <h3 style="color: var(--warn);">Important Disclaimer</h3>
      <p style="color: var(--muted); font-size: 0.85rem; margin-top: 8px;">
        All savings estimates are probabilistic outputs of Monte Carlo simulation.
        Financial calculations use deterministic, auditable arithmetic — not AI-generated values.
        Actual savings depend on implementation quality, model behavior, and business constraints.
        This report does not constitute financial or operational advice.
      </p>
    </div>

    <div class="footer">
      <p>Generated by <strong>AI Cost Auditor v0.1.0</strong> &bull; Seed-locked PRNG &bull; Reproducible</p>
    </div>
  </div>
</body>
</html>"""


class ReportGenerator:
    """Generates executive AI cost reports in HTML and JSON formats."""

    def __init__(self, pricing_registry: PricingRegistry):
        self.registry = pricing_registry
        self.calculator = CostCalculator(pricing_registry)

    def generate_html(
        self,
        audit: Audit,
        records: list[UsageRecord],
        findings: list[Finding],
        simulations: list[SimulationManifest],
    ) -> str:
        data = self._compile_data(audit, records, findings, simulations)
        return self._render_html(data)

    def generate_json(
        self,
        audit: Audit,
        records: list[UsageRecord],
        findings: list[Finding],
        simulations: list[SimulationManifest],
    ) -> dict[str, Any]:
        return self._compile_data(audit, records, findings, simulations)

    def _compile_data(
        self,
        audit: Audit,
        records: list[UsageRecord],
        findings: list[Finding],
        simulations: list[SimulationManifest],
    ) -> dict[str, Any]:
        """Compile all report data from structured sources (never LLM)."""
        breakdown = self.calculator.build_cost_breakdown(records) if records else None

        # Sort findings by potential savings desc
        sorted_findings = sorted(
            findings,
            key=lambda f: f.potential_savings_low,
            reverse=True,
        )

        # Aggregate simulation stats (latest simulation if any)
        sim_stats = None
        if simulations:
            latest_manifest = simulations[0]
            sim_stats = {
                "simulation_id": latest_manifest.simulation_id,
                "seed": latest_manifest.seed,
                "iterations": latest_manifest.iteration_count,
                "results_hash": latest_manifest.results_hash,
            }

        # Total potential savings from approved/simulated findings
        total_savings_low = sum(
            f.potential_savings_low for f in findings
            if f.validation_status in ("SIMULATED", "VALIDATED")
        )
        total_savings_high = sum(
            f.potential_savings_high for f in findings
            if f.validation_status in ("SIMULATED", "VALIDATED")
        )
        savings_midpoint = (total_savings_low + total_savings_high) / Decimal("2")

        return {
            "audit_id": audit.audit_id,
            "customer_name": audit.customer_name,
            "period_start": audit.period_start.isoformat(),
            "period_end": audit.period_end.isoformat(),
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "baseline_monthly_cost": float(audit.baseline_monthly_cost),
            "baseline_annual_cost": float(audit.baseline_annual_cost),
            "total_records": audit.total_records,
            "findings_count": len(findings),
            "findings": [
                {
                    "finding_id": f.finding_id,
                    "category": f.category,
                    "severity": f.severity,
                    "title": f.title,
                    "description": f.description,
                    "recommendation": f.recommendation,
                    "affected_workloads": f.affected_workloads,
                    "affected_models": f.affected_models,
                    "potential_savings_low": float(f.potential_savings_low),
                    "potential_savings_high": float(f.potential_savings_high),
                    "confidence": f.confidence,
                    "validation_status": f.validation_status,
                    "review_status": f.review_status,
                }
                for f in sorted_findings
            ],
            "savings_estimate": {
                "total_monthly_low": float(total_savings_low),
                "total_monthly_high": float(total_savings_high),
                "total_monthly_midpoint": float(savings_midpoint),
                "total_annual_low": float(total_savings_low * 12),
                "total_annual_high": float(total_savings_high * 12),
                "pct_monthly": (
                    float(savings_midpoint / audit.baseline_monthly_cost * 100)
                    if audit.baseline_monthly_cost > 0
                    else 0
                ),
            },
            "cost_breakdown": (
                {
                    "by_model": breakdown.cost_by_model if breakdown else {},
                    "by_provider": breakdown.cost_by_provider if breakdown else {},
                    "by_application": breakdown.cost_by_application if breakdown else {},
                    "failure_cost": float(breakdown.failure_cost) if breakdown else 0,
                    "retry_cost": float(breakdown.retry_cost) if breakdown else 0,
                    "total_cost": float(breakdown.total_cost) if breakdown else 0,
                }
            ),
            "simulation": sim_stats,
        }

    def _render_html(self, data: dict[str, Any]) -> str:
        """Render HTML report from compiled data."""
        # Simulation section
        sim = data.get("simulation")
        savings = data.get("savings_estimate", {})
        pct = savings.get("pct_monthly", 0)
        p_low = savings.get("total_monthly_low", 0)
        p_high = savings.get("total_monthly_high", 0)
        p_mid = savings.get("total_monthly_midpoint", 0)
        a_low = savings.get("total_annual_low", 0)
        a_high = savings.get("total_annual_high", 0)

        if sim:
            simulation_section = f"""
<div class="card" style="border-color: var(--accent2);">
  <h2>&#127922; Monte Carlo Simulation Results</h2>
  <p style="color: var(--muted); font-size:0.85rem; margin-bottom:16px;">
    Simulation ID: <code style="color:var(--accent)">{sim['simulation_id']}</code>
    &bull; Seed: <strong>{sim['seed']}</strong>
    &bull; {sim['iterations']:,} iterations
    &bull; Results hash: <code style="color:var(--muted); font-size:0.75rem">{sim['results_hash'][:16]}…</code>
  </p>
  <div class="savings-grid">
    <div class="savings-stat">
      <div class="value">${p_mid:,.0f}</div>
      <div class="label">Monthly Savings (midpoint)</div>
    </div>
    <div class="savings-stat">
      <div class="value">${p_low:,.0f} – ${p_high:,.0f}</div>
      <div class="label">Monthly Savings (range)</div>
    </div>
    <div class="savings-stat">
      <div class="value">${a_low/1000:,.0f}k – ${a_high/1000:,.0f}k</div>
      <div class="label">Annual Savings (range)</div>
    </div>
    <div class="savings-stat">
      <div class="value">{pct:.1f}%</div>
      <div class="label">Savings Rate</div>
    </div>
  </div>
</div>"""
        else:
            simulation_section = f"""
<div class="card">
  <h2>&#127922; Savings Estimate</h2>
  <div class="savings-grid">
    <div class="savings-stat">
      <div class="value">${p_low:,.0f} – ${p_high:,.0f}</div>
      <div class="label">Est. Monthly Savings</div>
    </div>
    <div class="savings-stat">
      <div class="value">${a_low/1000:,.0f}k – ${a_high/1000:,.0f}k</div>
      <div class="label">Est. Annual Savings</div>
    </div>
    <div class="savings-stat">
      <div class="value">{pct:.1f}%</div>
      <div class="label">Savings Rate</div>
    </div>
  </div>
  <p style="color:var(--muted);font-size:0.8rem;margin-top:16px;">
    &#9888; No Monte Carlo simulation has been run. Estimates are deterministic ranges only.
    Run <code>POST /audits/{data['audit_id']}/simulate</code> for probabilistic confidence intervals.
  </p>
</div>"""

        # Findings table
        findings = data.get("findings", [])
        if findings:
            rows = ""
            for f in findings:
                sev = f["severity"].lower()
                sev_class = f"badge-{sev}" if sev in ("high", "medium", "low") else "badge-ok"
                rows += f"""
              <tr>
                <td><strong>{f['title']}</strong><br><span style="color:var(--muted);font-size:0.8rem">{f['category']}</span></td>
                <td><span class="badge {sev_class}">{f['severity']}</span></td>
                <td style="color:var(--text)">{', '.join(f['affected_models'][:2]) or '—'}</td>
                <td style="color:var(--accent2)">${f['potential_savings_low']:,.0f} – ${f['potential_savings_high']:,.0f}/mo</td>
                <td style="color:var(--muted);font-size:0.82rem">{f['confidence']}</td>
              </tr>"""
            findings_table = f"""
            <table>
              <thead>
                <tr>
                  <th>Finding</th><th>Severity</th><th>Models</th><th>Est. Savings/mo</th><th>Confidence</th>
                </tr>
              </thead>
              <tbody>{rows}</tbody>
            </table>"""
        else:
            findings_table = "<p style='color:var(--muted)'>No findings detected. Run <code>POST /audits/{audit_id}/detect</code> first.</p>"

        # Cost breakdown table
        cost_by_model = data.get("cost_breakdown", {}).get("by_model", {})
        if cost_by_model:
            total = sum(cost_by_model.values())
            rows = ""
            for model, cost in sorted(cost_by_model.items(), key=lambda x: x[1], reverse=True):
                pct_m = (cost / total * 100) if total > 0 else 0
                bar = f'<div class="cost-bar"><div class="cost-bar-fill" style="width:{min(pct_m,100):.0f}%"></div></div>'
                rows += f"""
              <tr>
                <td>{model}</td>
                <td>${cost:,.2f}<br>{bar}</td>
                <td style="color:var(--muted)">{pct_m:.1f}%</td>
              </tr>"""
            cost_breakdown_table = f"""
            <table>
              <thead><tr><th>Model</th><th>Monthly Cost</th><th>Share</th></tr></thead>
              <tbody>{rows}</tbody>
            </table>"""
        else:
            cost_breakdown_table = "<p style='color:var(--muted)'>No cost data available.</p>"

        return HTML_TEMPLATE.format(
            customer_name=data["customer_name"],
            period_start=data["period_start"],
            period_end=data["period_end"],
            generated_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
            baseline_monthly=data["baseline_monthly_cost"],
            savings_p50_monthly=p_mid,
            pct_savings=pct,
            findings_count=data["findings_count"],
            simulation_section=simulation_section,
            findings_table=findings_table,
            cost_breakdown_table=cost_breakdown_table,
        )
