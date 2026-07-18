/**
 * Handshake & capability negotiation (design §7) — the cross-ecosystem interop contract shared by the
 * adonis, nestjs (aviary) and python durable SDKs. Pure logic, no transport: the worker/control-plane
 * wiring feeds live descriptors in and acts on the result.
 */
export {
  CURRENT_PROTOCOL_VERSION,
  LEGACY_V1_PROTOCOL,
  LEGACY_V1_CAPABILITIES,
  type WorkerDescriptor,
  type RawWorkerDescriptor,
  type WorkerLifecycle,
  type HeartbeatStatus,
  descriptorHash,
  heartbeatStatus,
  isLegacyDescriptor,
  normalizeDescriptor,
} from './descriptor';
export {
  type NegotiationOutcome,
  type NegotiationReason,
  type NegotiationResult,
  type NegotiateOptions,
  negotiate,
} from './negotiate';
export {
  type CapabilityRequirement,
  type RoutableResolution,
  type BlockedResolution,
  type RoutingResolution,
  requiredCapabilities,
  canRoute,
  missingCapabilities,
  capableWorkers,
  resolveRouting,
} from './routing';
