import { useState } from 'react';
import { gql } from '@apollo/client/core';
import { useMutation, useSubscription } from '@apollo/client/react';
import './WorkflowRunner.css';

// Matches the Hasura Action registered from triggerWorkflowRun.js
const TRIGGER_WORKFLOW = gql`
  mutation TriggerWorkflow($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      success
      status
      workflow_run_id
    }
  }
`;

// Matches the Hasura Action registered from approveStep.js — note it takes
// step_run_id, not workflow_run_id, since approval applies to one specific
// paused step.
const APPROVE_STEP = gql`
  mutation ApproveStep($step_run_id: uuid!) {
    approveStep(step_run_id: $step_run_id) {
      success
      status
      workflow_run_id
    }
  }
`;

// Live feed for a single run — split into two subscriptions because
// Hasura requires exactly one top-level field per subscription.
const STEP_RUNS_SUBSCRIPTION = gql`
  subscription WatchStepRuns($workflow_run_id: uuid!) {
    step_runs(
      where: { workflow_run_id: { _eq: $workflow_run_id } }
      order_by: { step_order: asc }
    ) {
      id
      step_order
      type
      status
      output
      error
      attempt_count
      approved_by
      approved_at
    }
  }
`;

const RUN_STATUS_SUBSCRIPTION = gql`
  subscription WatchRunStatus($workflow_run_id: uuid!) {
    workflow_runs_by_pk(id: $workflow_run_id) {
      id
      status
      current_step_order
    }
  }
`;

const STATUS_META = {
  pending: { label: 'Queued', tone: 'muted' },
  running: { label: 'Running', tone: 'teal' },
  paused: { label: 'Paused', tone: 'amber' },
  completed: { label: 'Done', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

function StatusPill({ status }) {
  const meta = STATUS_META[status] || { label: status, tone: 'muted' };
  return <span className={`pill pill--${meta.tone}`}>{meta.label}</span>;
}

export default function WorkflowRunner({ workflowId }) {
  const [runId, setRunId] = useState(null);

  const [triggerWorkflow, { loading: triggering }] = useMutation(TRIGGER_WORKFLOW);
  const [approveStep, { loading: approving }] = useMutation(APPROVE_STEP);

  const { data: stepData } = useSubscription(STEP_RUNS_SUBSCRIPTION, {
    variables: { workflow_run_id: runId },
    skip: !runId,
  });

  const { data: runData } = useSubscription(RUN_STATUS_SUBSCRIPTION, {
    variables: { workflow_run_id: runId },
    skip: !runId,
  });

  const steps = stepData?.step_runs ?? [];
  const runStatus = runData?.workflow_runs_by_pk?.status ?? null;
  const pausedStep = steps.find((s) => s.status === 'paused');

  async function handleRun() {
    try {
      const { data } = await triggerWorkflow({ variables: { workflow_id: workflowId } });
      setRunId(data.triggerWorkflowRun.workflow_run_id);
    } catch (err) {
      alert('Failed to start run: ' + err.message);
    }
  }

  async function handleApprove(stepRunId) {
    try {
      await approveStep({ variables: { step_run_id: stepRunId } });
    } catch (err) {
      alert('Approval failed: ' + err.message);
    }
  }

  return (
    <div className="runner">
      <div className="runner-header">
        <div>
          <p className="runner-eyebrow">Manual trigger</p>
          <h2 className="runner-title">Run this workflow</h2>
        </div>
        <button className="run-button" onClick={handleRun} disabled={triggering || runStatus === 'running'}>
          {triggering ? 'Starting…' : '▶ Run workflow'}
        </button>
      </div>

      {runId && (
        <div className="runner-body">
          <div className="runner-track-header">
            <span className="track-label">Run status</span>
            {runStatus && <StatusPill status={runStatus} />}
          </div>

          <ol className="track">
            {steps.map((step, i) => (
              <li key={step.id} className={`track-node track-node--${STATUS_META[step.status]?.tone || 'muted'}`}>
                <div className="track-node-marker">
                  {step.status === 'completed' ? '✓' : step.status === 'failed' ? '✕' : i + 1}
                </div>
                <div className="track-node-body">
                  <div className="track-node-top">
                    <span className="track-node-type">{step.type}</span>
                    <StatusPill status={step.status} />
                  </div>
                  {step.attempt_count > 1 && (
                    <p className="track-node-meta">Retried — attempt {step.attempt_count}</p>
                  )}
                  {step.error && <p className="track-node-error">{step.error}</p>}
                  {step.approved_by && (
                    <p className="track-node-meta">Approved {new Date(step.approved_at).toLocaleTimeString()}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {pausedStep && (
            <div className="approval-box">
              <p className="approval-box-label">
                Awaiting approval — step {pausedStep.step_order} ({pausedStep.type})
              </p>
              <button
                className="approve-button"
                onClick={() => handleApprove(pausedStep.id)}
                disabled={approving}
              >
                {approving ? 'Approving…' : '✓ Approve and resume'}
              </button>
            </div>
          )}

          {runStatus === 'completed' && <p className="final-msg final-msg--green">Run completed.</p>}
          {runStatus === 'failed' && <p className="final-msg final-msg--red">Run failed.</p>}
        </div>
      )}
    </div>
  );
}