import { useState } from 'react';
import { gql } from '@apollo/client/core';
import { useMutation, useSubscription } from '@apollo/client/react';
import './WorkflowRunner.css';

// Phase 1: create the run row only. Returns fast — no step execution here.
const TRIGGER_WORKFLOW = gql`
  mutation TriggerWorkflow($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      success
      status
      workflow_run_id
    }
  }
`;

// Phase 2: actually run the steps. Called AFTER the subscription below is
// already mounted, so its writes are visible live instead of arriving as one
// completed blob.
const EXECUTE_WORKFLOW = gql`
  mutation ExecuteWorkflow($workflow_run_id: uuid!) {
    executeWorkflowRun(workflow_run_id: $workflow_run_id) {
      success
      status
      workflow_run_id
    }
  }
`;

const APPROVE_STEP = gql`
  mutation ApproveStep($step_run_id: uuid!) {
    approveStep(step_run_id: $step_run_id) {
      success
      status
      workflow_run_id
    }
  }
`;

const REJECT_STEP = gql`
  mutation RejectStep($step_run_id: uuid!) {
    rejectStep(step_run_id: $step_run_id) {
      success
      status
      workflow_run_id
      reject_count
    }
  }
`;

// decision: "ok" = Approve (ignore the flagged result, keep going)
//           "reject" = Reject (stop the run here, marked completed)
const RESOLVE_BRANCH = gql`
  mutation ResolveBranch($step_run_id: uuid!, $decision: String!) {
    resolveBranch(step_run_id: $step_run_id, decision: $decision) {
      success
      status
      workflow_run_id
      decision
    }
  }
`;

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
      reject_count
    }
  }
`;

const MAX_REJECTS = 3;

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
  const [starting, setStarting] = useState(false);

  const [triggerWorkflow] = useMutation(TRIGGER_WORKFLOW);
  const [executeWorkflow] = useMutation(EXECUTE_WORKFLOW);
  const [approveStep, { loading: approving }] = useMutation(APPROVE_STEP);
  const [rejectStep, { loading: rejecting }] = useMutation(REJECT_STEP);
  const [resolveBranch, { loading: resolving }] = useMutation(RESOLVE_BRANCH);

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
  const rejectCount = runData?.workflow_runs_by_pk?.reject_count ?? 0;
  const pausedStep = steps.find((s) => s.status === 'paused');
  // A conditional_branch that evaluated false pauses the RUN but the step
  // itself stays "completed" (it did run — it just produced a false result).
  // Distinguish it from approval_gate pauses by type + result, and only
  // treat it as "awaiting a decision" if it hasn't been resolved yet (no note).
  const branchPause = runStatus === 'paused'
    ? steps.find((s) => s.type === 'conditional_branch' && s.output?.result === false && !s.error)
    : null;
  const runningStep = steps.find((s) => s.status === 'running');

  // A conditional_branch that evaluated false and the user chose Reject on
  // stops the run right there — that's a legitimate, deliberate outcome
  // (status "completed" with fewer than the full step count), not a bug.
  // Surface it distinctly instead of just "Done".
  const branchStop = runStatus === 'completed'
    ? steps.find((s) => s.type === 'conditional_branch' && s.output?.result === false)
    : null;

  async function handleRun() {
    setStarting(true);
    try {
      // Phase 1: create the run, get the id, mount subscriptions immediately.
      const { data } = await triggerWorkflow({ variables: { workflow_id: workflowId } });
      const newRunId = data.triggerWorkflowRun.workflow_run_id;
      setRunId(newRunId);

      // Phase 2: kick off execution. Subscriptions above are already
      // connected by the time this resolves, so every step transition
      // (running -> completed/paused/failed) is visible as it happens.
      await executeWorkflow({ variables: { workflow_run_id: newRunId } });
    } catch (err) {
      alert('Failed to run workflow: ' + err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleApprove(stepRunId) {
    try {
      await approveStep({ variables: { step_run_id: stepRunId } });
    } catch (err) {
      alert('Approval failed: ' + err.message);
    }
  }

  async function handleReject(stepRunId) {
    try {
      await rejectStep({ variables: { step_run_id: stepRunId } });
    } catch (err) {
      alert('Reject failed: ' + err.message);
    }
  }

  // decision: 'ok' = Approve (ignore, keep going) | 'reject' = Reject (stop here)
  async function handleResolveBranch(stepRunId, decision) {
    try {
      await resolveBranch({ variables: { step_run_id: stepRunId, decision } });
    } catch (err) {
      alert('Failed to submit decision: ' + err.message);
    }
  }

  const isBusy = starting || runStatus === 'pending' || runStatus === 'running';

  return (
    <div className="runner">
      <div className="runner-header">
        <div>
          <p className="runner-eyebrow">Manual trigger</p>
          <h2 className="runner-title">Run this workflow</h2>
        </div>
        <button className="run-button" onClick={handleRun} disabled={isBusy}>
          {isBusy ? 'Running…' : '▶ Run workflow'}
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
                  {step.status === 'completed' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'running' ? '…' : i + 1}
                </div>
                <div className="track-node-body">
                  <div className="track-node-top">
                    <span className="track-node-type">{step.type}</span>
                    <StatusPill status={step.status} />
                  </div>
                  {step.status === 'running' && (
                    <p className="track-node-meta">Processing…</p>
                  )}
                  {step.attempt_count > 1 && (
                    <p className="track-node-meta">Retried — attempt {step.attempt_count}</p>
                  )}
                  {step.error && <p className="track-node-error">{step.error}</p>}
                  {step.approved_by && (
                    <p className="track-node-meta">Approved {new Date(step.approved_at).toLocaleTimeString()}</p>
                  )}
                  {step.type === 'conditional_branch' && step.status === 'completed' && (
                    <p className="track-node-meta">
                      Condition "{step.output?.condition}" evaluated {String(step.output?.result)}
                    </p>
                  )}
                </div>
              </li>
            ))}
            {/* Placeholder rail entries for steps not yet started, so the full
                path is visible even before those rows exist in step_runs. */}
          </ol>

          {branchPause && (
            <div className="approval-box approval-box--branch">
              <p className="approval-box-label">
                Step {branchPause.step_order} flagged ("{branchPause.output?.condition}") —
                Approve to ignore it and continue, or Reject to stop the run here.
              </p>
              <div className="approval-box-actions">
                <button
                  className="approve-button"
                  onClick={() => handleResolveBranch(branchPause.id, 'ok')}
                  disabled={resolving}
                >
                  {resolving ? 'Working…' : '✓ Approve'}
                </button>
                <button
                  className="reject-button"
                  onClick={() => handleResolveBranch(branchPause.id, 'reject')}
                  disabled={resolving}
                >
                  {resolving ? 'Working…' : '✕ Reject'}
                </button>
              </div>
            </div>
          )}

          {pausedStep && (
            <div className="approval-box">
              <p className="approval-box-label">
                Awaiting approval — step {pausedStep.step_order} ({pausedStep.type})
              </p>
              {rejectCount > 0 && (
                <p className="track-node-meta">
                  Rejected {rejectCount}/{MAX_REJECTS} — {MAX_REJECTS - rejectCount} more and this run stops.
                </p>
              )}
              <div className="approval-box-actions">
                <button
                  className="approve-button"
                  onClick={() => handleApprove(pausedStep.id)}
                  disabled={approving || rejecting}
                >
                  {approving ? 'Approving…' : '✓ Approve and resume'}
                </button>
                <button
                  className="reject-button"
                  onClick={() => handleReject(pausedStep.id)}
                  disabled={approving || rejecting}
                >
                  {rejecting ? 'Rejecting…' : '✕ Reject'}
                </button>
              </div>
            </div>
          )}

          {runStatus === 'failed' && rejectCount >= MAX_REJECTS && (
            <p className="final-msg final-msg--red">
              Run stopped — rejected {MAX_REJECTS} times in a row.
            </p>
          )}

          {runStatus === 'completed' && branchStop && (
            <p className="final-msg final-msg--amber">
              Run completed — stopped after step {branchStop.step_order} because you chose
              Reject on the flagged condition. Remaining steps were not run.
            </p>
          )}
          {runStatus === 'completed' && !branchStop && (
            <p className="final-msg final-msg--green">Run completed — all steps finished.</p>
          )}
          {runStatus === 'failed' && rejectCount < MAX_REJECTS && (
            <p className="final-msg final-msg--red">Run failed.</p>
          )}
        </div>
      )}
    </div>
  );
}