/**
 * External AI & MiniMind Provider Wrappers
 *
 * Re-exports and wraps existing `LocalGateway` (MiniMind) and `OpenRouterGateway` / `DeterministicGateway`
 * so the new inference pipeline reuses the existing gateway adapters without duplication.
 */

export { LocalGateway as MiniMindGateway, LocalGatewayConfig as MiniMindGatewayConfig } from '../../gateways/local';
export { OpenRouterGateway, OpenRouterConfig, OpenRouterError } from '../../gateways/openrouter';
export { DeterministicGateway, DeterministicGatewayConfig } from '../../gateways/deterministic';
