/**
 * Observability Telemetry Re-exports & Extensions
 *
 * Re-exports the existing `SCPTracer`, `recordRoutingDecision`, and `buildTelemetryFromDecision`
 * from `../telemetry` so all modules share the single telemetry pipeline.
 */

export {
  SCPSpan,
  SCPTracer,
  recordRoutingDecision,
  buildTelemetryFromDecision,
} from '../telemetry';
