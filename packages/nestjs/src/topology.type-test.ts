import type { StateStore, Transport } from '@dudousxd/nestjs-durable-core';
import type { DurableModuleOptions } from './durable.module';

// Compile-time only: `topology` discriminates the options, so a role's forbidden axes are type errors.

declare const store: StateStore;
declare const transport: Transport;

export const standalone: DurableModuleOptions = { store, transport };
export const explicitStandalone: DurableModuleOptions = {
  topology: 'standalone',
  connection: 'redis://x',
  partition: 'acme',
};
export const controlPlane: DurableModuleOptions = {
  topology: 'control-plane',
  partition: 'local',
  store,
  transport,
};
export const tenant: DurableModuleOptions = {
  topology: 'tenant',
  partition: 'acme',
  connection: 'redis://x',
  transport,
  tenantToken: 'acme.sig',
};

// @ts-expect-error a tenant is store-less
export const tenantWithStore: DurableModuleOptions = {
  topology: 'tenant',
  partition: 'acme',
  connection: 'redis://x',
  store,
};

// @ts-expect-error a tenant must name its partition
export const tenantWithoutPartition: DurableModuleOptions = {
  topology: 'tenant',
  connection: 'redis://x',
};

// @ts-expect-error `namespace` is the operator's axis
export const tenantWithNamespace: DurableModuleOptions = {
  topology: 'tenant',
  partition: 'acme',
  connection: 'redis://x',
  namespace: 'acme',
};

// @ts-expect-error a control plane owns a store
export const controlPlaneWithoutStore: DurableModuleOptions = {
  topology: 'control-plane',
  transport,
};

export const objectForm: DurableModuleOptions = {
  // @ts-expect-error the object form is gone
  topology: { role: 'tenant', tenant: 'acme' },
  connection: 'redis://x',
};
