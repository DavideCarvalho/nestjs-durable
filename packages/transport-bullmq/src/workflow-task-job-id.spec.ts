import { describe, expect, it } from 'vitest';
import { workflowTaskJobId } from './workflow-task-job-id';

describe('workflowTaskJobId', () => {
  it('carries no `:`, which BullMQ refuses in a custom job id', () => {
    expect(workflowTaskJobId('run-1:wf:0a1b2c3d')).toBe('wf-run-1_cwf_c0a1b2c3d');
    expect(workflowTaskJobId('a:b:c')).not.toContain(':');
  });

  it('escapes one-to-one, so task ids mixing `_` and `:` never share a job id', () => {
    const ids = ['a_b', 'a:b', 'a_cb', 'a_ub', 'a__b', 'a::b', 'a_:b', 'a:_b', 'a_u', 'a:', 'a_c'];
    const jobIds = ids.map(workflowTaskJobId);
    expect(new Set(jobIds).size).toBe(ids.length);
    expect(workflowTaskJobId('a_b')).toBe('wf-a_ub');
    expect(workflowTaskJobId('a:b')).toBe('wf-a_cb');
    expect(workflowTaskJobId('a_cb')).toBe('wf-a_ucb');
  });
});
