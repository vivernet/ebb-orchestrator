/**
 * In-memory event bus – manages subscriptions to domain event types.
 */

import type { DomainEvent } from "./domain-event.js";

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export interface Subscription {
  readonly type: string;
  readonly name: string;
  readonly handler: EventHandler;
}

/**
 * Предоставляет публичный контракт модуля event-bus для взаимодействия слоёв приложения.
 */
export class EventBus {
  private subscriptions: Subscription[] = [];

  subscribe(type: string, consumerName: string, handler: EventHandler): void {
    this.subscriptions.push({ type, name: consumerName, handler });
  }

  subscriptionsFor(type: string): Subscription[] {
    return this.subscriptions.filter((s) => s.type === type);
  }
}
