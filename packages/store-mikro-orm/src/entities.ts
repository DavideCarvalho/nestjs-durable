import type { RunStatus, StepKind } from '@dudousxd/nestjs-durable-core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'durable_workflow_runs' })
export class WorkflowRunEntity {
  @PrimaryKey()
  id!: string;

  @Property()
  workflow!: string;

  @Property()
  workflowVersion!: string;

  @Property()
  status!: RunStatus;

  @Property({ type: 'json', nullable: true })
  input?: unknown;

  @Property({ type: 'json', nullable: true })
  output?: unknown;

  @Property({ type: 'json', nullable: true })
  error?: unknown;

  @Property({ nullable: true })
  wakeAt?: Date;

  @Property({ nullable: true })
  lockedBy?: string;

  @Property({ nullable: true })
  lockedUntil?: Date;

  @Property()
  createdAt!: Date;

  @Property()
  updatedAt!: Date;
}

@Entity({ tableName: 'durable_step_checkpoints' })
export class StepCheckpointEntity {
  @PrimaryKey()
  runId!: string;

  @PrimaryKey()
  seq!: number;

  @Property()
  name!: string;

  @Property()
  kind!: StepKind;

  @Property()
  stepId!: string;

  @Property()
  status!: 'completed' | 'failed';

  @Property({ type: 'json', nullable: true })
  output?: unknown;

  @Property({ type: 'json', nullable: true })
  error?: unknown;

  @Property()
  attempts!: number;

  @Property({ nullable: true })
  workerGroup?: string;

  @Property({ nullable: true })
  wakeAt?: Date;

  @Property({ nullable: true })
  enqueuedAt?: Date;

  @Property()
  startedAt!: Date;

  @Property()
  finishedAt!: Date;
}

@Entity({ tableName: 'durable_signal_waiters' })
export class SignalWaiterEntity {
  @PrimaryKey()
  token!: string;

  @Property()
  runId!: string;

  @Property()
  seq!: number;
}

export const ENTITIES = [WorkflowRunEntity, StepCheckpointEntity, SignalWaiterEntity] as const;
