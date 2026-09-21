/**
 * Value object доменного события.
 */

export interface DomainEventInput {
  type: string;
  aggregateType?: string;
  aggregateId?: string;
  payload: Record<string, unknown>;
}

export interface DomainEvent<TType extends string = string, TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly type: TType;
  readonly aggregateType: string | undefined;
  readonly aggregateId: string | undefined;
  readonly payload: TPayload;
  readonly createdAt: string;
  readonly availableAt: string;
}

export const DomainEvent = {
  create(input: DomainEventInput): DomainEvent {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      type: input.type,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
      createdAt: now,
      availableAt: now,
    };
  },
};
