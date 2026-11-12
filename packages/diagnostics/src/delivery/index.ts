/**
 * `@dudousxd/nestjs-durable-diagnostics/delivery`: the module `transports.durable()` of
 * `@dudousxd/nestjs-diagnostics` loads at bootstrap. It runs every diagnostics listener call as a
 * durable run. Diagnostics is only imported for its types, so this module never loads it.
 */
import type { DurableDiagnosticsDeliveryModule } from '@dudousxd/nestjs-diagnostics/nestjs';
import { createDeliveryTransport, isConfigured } from './transport';

export {
  createDeliveryTransport,
  DIAGNOSTICS_DEFAULT_RETRY,
  DIAGNOSTICS_LISTENER_ORIGIN,
  DIAGNOSTICS_LISTENER_STEP,
  DIAGNOSTICS_LISTENER_WORKFLOW,
  DIAGNOSTICS_LISTENER_WORKFLOW_VERSION,
  DIAGNOSTICS_RUN_PREFIX,
  type DiagnosticsListenerInput,
  DurableDeliveryTransport,
  diagnosticsRunId,
  diagnosticsRunTags,
  isConfigured,
  isDiagnosticsDeliveryEvent,
} from './transport';

/** The module as one object. Typing it checks this module is what `transports.durable()` expects. */
const durableDiagnosticsDelivery: DurableDiagnosticsDeliveryModule = {
  isConfigured,
  createDeliveryTransport,
};
export default durableDiagnosticsDelivery;
