/**
 * A minimal ElizaOS-shaped runtime.
 *
 * The plugin's real home is an agent, but an agent needs a model provider, a
 * database, and a message loop — none of which say anything about whether the
 * treasury works. This implements just the surface the plugin actually touches
 * (`getSetting`, `getService`) so the service, provider, and actions can be
 * driven directly: in tests, in CI, and in the demo.
 *
 * It is exported from the package on purpose. Anyone integrating Bursar wants
 * to prove their treasury config moves money *before* wiring it into a live
 * agent, and this is how.
 */

import type { IAgentRuntime, Memory, Service, State } from "@elizaos/core";

export interface StandaloneOptions {
  settings: Record<string, string | undefined>;
}

export interface StandaloneRuntime {
  runtime: IAgentRuntime;
  /** Start a service class and register it, exactly as the runtime would. */
  startService<T extends Service>(
    ServiceClass: { serviceType: string; start(runtime: IAgentRuntime): Promise<T> },
  ): Promise<T>;
  stopAll(): Promise<void>;
}

export function createStandaloneRuntime(options: StandaloneOptions): StandaloneRuntime {
  const services = new Map<string, Service>();

  const runtime = {
    getSetting(key: string): string | undefined {
      return options.settings[key];
    },
    getService<T>(serviceType: string): T | null {
      return (services.get(serviceType) as T | undefined) ?? null;
    },
  } as unknown as IAgentRuntime;

  return {
    runtime,
    async startService<T extends Service>(ServiceClass: {
      serviceType: string;
      start(runtime: IAgentRuntime): Promise<T>;
    }): Promise<T> {
      const service = await ServiceClass.start(runtime);
      services.set(ServiceClass.serviceType, service);
      return service;
    },
    async stopAll(): Promise<void> {
      for (const service of services.values()) await service.stop();
      services.clear();
    },
  };
}

/** A message shaped the way an action handler expects to receive one. */
export function userMessage(text: string): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    entityId: "user",
    roomId: "standalone",
    content: { text },
    createdAt: Date.now(),
  } as unknown as Memory;
}

/** Empty state — the plugin's provider and actions do not read from it. */
export function emptyState(): State {
  return { values: {}, data: {}, text: "" } as unknown as State;
}
