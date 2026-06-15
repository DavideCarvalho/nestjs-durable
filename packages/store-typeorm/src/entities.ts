import type { RunStatus, StepKind } from '@dudousxd/nestjs-durable-core';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'durable_workflow_runs' })
export class WorkflowRunEntity {
  @PrimaryColumn('text')
  id!: string;

  @Column('text')
  workflow!: string;

  @Column('text')
  workflowVersion!: string;

  @Column('text')
  status!: RunStatus;

  @Column('simple-json', { nullable: true })
  input?: unknown;

  @Column('simple-json', { nullable: true })
  output?: unknown;

  @Column('simple-json', { nullable: true })
  error?: unknown;

  @Column({ nullable: true })
  wakeAt?: Date;

  @Column('text', { nullable: true })
  lockedBy?: string | null;

  @Column({ nullable: true })
  lockedUntil?: Date;

  @Column('integer', { nullable: true })
  recoveryAttempts?: number;

  @Column('simple-json', { nullable: true })
  tags?: string[] | null;

  @Column('simple-json', { nullable: true })
  searchAttributes?: Record<string, string | number | boolean> | null;

  @Column()
  createdAt!: Date;

  @Column()
  updatedAt!: Date;
}

@Entity({ name: 'durable_step_checkpoints' })
export class StepCheckpointEntity {
  @PrimaryColumn('text')
  runId!: string;

  @PrimaryColumn('integer')
  seq!: number;

  @Column('text')
  name!: string;

  @Column('text')
  kind!: StepKind;

  @Column('text')
  stepId!: string;

  @Column('text')
  status!: 'pending' | 'completed' | 'failed';

  @Column('simple-json', { nullable: true })
  input?: unknown;

  @Column('simple-json', { nullable: true })
  output?: unknown;

  @Column('simple-json', { nullable: true })
  error?: unknown;

  @Column('simple-json', { nullable: true })
  events?: unknown;

  @Column('integer')
  attempts!: number;

  @Column('text', { nullable: true })
  workerGroup?: string | null;

  @Column({ nullable: true })
  wakeAt?: Date;

  @Column({ nullable: true })
  enqueuedAt?: Date;

  @Column()
  startedAt!: Date;

  @Column()
  finishedAt!: Date;
}

@Entity({ name: 'durable_signal_waiters' })
export class SignalWaiterEntity {
  @PrimaryColumn('text')
  token!: string;

  @Column('text')
  runId!: string;

  @Column('integer')
  seq!: number;
}

export const ENTITIES = [WorkflowRunEntity, StepCheckpointEntity, SignalWaiterEntity] as const;
