// executeWorkflowRun.js
// Hasura Action handler: POST /executeWorkflowRun
// Input: { workflow_run_id }
// NEW FILE — this is the execution half that used to live inside
// triggerWorkflowRun.js. Called by the frontend right after it receives a
// workflow_run_id and mounts its subscriptions, so the live step-by-step
// progress is actually visible instead of happening entirely before the
// subscription existed.
//
// SECURITY NOTE: because this is now its own callable endpoint (not just an
// internal function), it re-checks the caller's org role itself — same
// pattern as approveStep.js. A run_id alone is not authorization; without
// this check, anyone who could see/guess a run_id could re-trigger execution
// on it regardless of org membership.

import { gql, executeStepsFrom } from './workflowEngine.js';

export default async function executeWorkflowRun(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  const workflow_run_id = body?.input?.workflow_run_id || body?.input?.workflowRunId;
  const userId = body?.session_variables?.['x-hasura-user-id'];

  if (!userId) {
    return res.status(400).json({ message: 'Unauthorized: No user ID found in session.' });
  }
  if (!workflow_run_id) {
    return res.status(400).json({ message: 'Bad Request: Missing workflow_run_id.' });
  }

  try {
    const query = `
      query GetRunContext($run_id: uuid!, $user_id: uuid!) {
        workflow_runs_by_pk(id: $run_id) {
          id
          status
          workflow {
            id
            organization {
              id
              quota_limit
              quota_used
              org_members(where: { user_id: { _eq: $user_id } }) {
                role
              }
            }
            workflow_steps(order_by: { step_order: asc }) {
              id
              step_order
              type
              config
            }
          }
        }
      }
    `;
    const data = await gql(query, { run_id: workflow_run_id, user_id: userId });
    const run = data.workflow_runs_by_pk;

    if (!run) {
      return res.status(400).json({ message: 'Workflow run not found.' });
    }
    // Idempotency guard: a double-click or retry shouldn't re-run a run that's
    // already in progress or finished.
    if (run.status !== 'pending') {
      return res.status(400).json({ message: `Run is not pending (status: ${run.status}).` });
    }

    const workflow = run.workflow;
    const org = workflow.organization;
    const members = org.org_members || [];

    if (members.length === 0) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this organization.' });
    }
    if (members[0].role === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot execute workflow runs.' });
    }

    // Flip pending -> running. The subscription (already mounted by now)
    // catches this transition.
    await gql(
      `mutation StartRun($id: uuid!) {
        update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: { status: "running" }) { id }
      }`,
      { id: workflow_run_id }
    );

    const steps = workflow.workflow_steps || [];
    const result = await executeStepsFrom({
      steps,
      startIndex: 0,
      workflowRunId: workflow_run_id,
      org,
      previousOutput: null
    });

    return res.status(200).json({
      success: true,
      workflow_run_id,
      status: result.status
    });
  } catch (error) {
    console.error('Workflow execution failed:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
}