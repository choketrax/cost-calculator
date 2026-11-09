import { Hono } from "hono";
import { Env } from "./index";

export const funnelRouter = new Hono<{ Bindings: Env }>();

export function calculateScore(data: any) {
  let score = 0;
  const reasons: string[] = [];
  
  // Spend score
  const spend = data.monthly_spend;
  if (spend === "1000-2999") { score += 3; }
  else if (spend === "3000-9999") { score += 12; }
  else if (spend === "10000-19999") { score += 22; reasons.push("spend_10k_plus"); }
  else if (spend === "20000-49999") { score += 27; reasons.push("spend_20k_plus"); }
  else if (spend === "50000+") { score += 30; reasons.push("spend_50k_plus"); }
  else { reasons.push("low_spend"); }

  // Workflow count and complexity
  const workflows = parseInt(data.workflows || "0", 10);
  if (workflows > 5) { score += 15; reasons.push("high_complexity"); }
  else if (workflows > 2) { score += 10; }
  else if (workflows > 0) { score += 5; }

  // Cost/margin attribution gap
  if (data.can_attribute_cost === "no") { score += 15; reasons.push("no_attribution"); }
  else if (data.can_attribute_cost === "partial") { score += 5; }

  // Evidence of waste or incidents
  if (data.recent_incidents === "yes") { score += 10; reasons.push("recent_incident"); }
  
  // Data and telemetry availability
  if (data.has_telemetry === "yes") { score += 10; reasons.push("has_telemetry"); }
  
  // Implementation readiness
  if (data.ready_to_implement === "yes") { score += 10; reasons.push("ready_to_implement"); }
  
  // Urgency and executive ownership
  if (data.is_decision_maker === "yes" && data.urgency === "high") { score += 10; reasons.push("high_urgency"); }

  let routing = "nurture";
  if (score >= 70) {
    routing = "qualified";
  } else if (score >= 50) {
    routing = "conditional";
  }

  // Mandatory manual review conditions
  if (data.regulated === "yes" || spend === "50000+" || data.major_incident === "yes") {
    if (routing === "qualified") {
      routing = "conditional";
      reasons.push("mandatory_manual_review");
    }
  }

  return { score, routing, reasons };
}

funnelRouter.post("/apply", async (c) => {
  const body = await c.req.json();
  const { score, routing, reasons } = calculateScore(body);
  
  const token = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const domain = body.email ? body.email.split('@')[1] : null;

  // Save to CRM (D1)
  try {
    await c.env.DB.prepare(
      `INSERT INTO funnel_applications 
       (application_id, token, email, domain, company, score, routing, reason_codes, raw_data, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      applicationId, 
      token, 
      body.email || 'unknown', 
      domain, 
      body.company || 'unknown',
      score, 
      routing, 
      JSON.stringify(reasons), 
      JSON.stringify(body)
    ).run();
  } catch (e: any) {
    console.error("Failed to insert funnel application", e.message);
    // Ignore error for now to allow local testing if DB is not setup
  }

  return c.json({
    success: true,
    routing: routing,
    score: score,
    token: token
  });
});
