import { AdapterRegistryError } from './errors.js';
import type { CapacityProviderAdapter } from './types.js';

export class CapacityAdapterRegistry {
  private readonly adapters = new Map<string, CapacityProviderAdapter>();

  register(adapter: CapacityProviderAdapter): void {
    if (!adapter.id || adapter.id.trim() !== adapter.id) {
      throw new AdapterRegistryError('Adapter ID must be a non-empty stable identifier');
    }

    if (this.adapters.has(adapter.id)) {
      throw new AdapterRegistryError(`Adapter already registered: ${adapter.id}`);
    }

    this.adapters.set(adapter.id, adapter);
  }

  get(providerId: string): CapacityProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  list(): readonly CapacityProviderAdapter[] {
    return [...this.adapters.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}
