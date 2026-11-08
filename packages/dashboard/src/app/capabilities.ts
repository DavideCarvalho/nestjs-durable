import { useQuery } from '@tanstack/react-query';
import {
  type ConsoleCapabilities,
  type DurableTopology,
  durableClient,
} from '../client/durable-client';

/** A console feature the server may not serve (see core's `ConsoleCapabilities`). */
export type ConsoleCapability = keyof ConsoleCapabilities;

/**
 * Whether the server serves `capability`. Supported unless the topology says `false`: a durable
 * gateway sends no capabilities at all, and a topology still loading hides nothing.
 */
export function supports(
  topology: DurableTopology | undefined,
  capability: ConsoleCapability,
): boolean {
  return topology?.capabilities?.[capability] !== false;
}

/** The deployment's topology, fetched once (the same query the header uses). */
export function useTopology(): DurableTopology | undefined {
  const { data } = useQuery({
    queryKey: ['topology'],
    queryFn: () => durableClient.topology(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data;
}

/** `supports()` bound to the current topology. */
export function useCapabilities(): (capability: ConsoleCapability) => boolean {
  const topology = useTopology();
  return (capability) => supports(topology, capability);
}
