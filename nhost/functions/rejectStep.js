// rejectStep.js
// Hasura Action handler: POST /rejectStep
// Input: { step_run_id }
// Same Layer 2 org-role check as approveStep.js. On reject: increments
// workflow_runs.reject_count. At 3 consecutive rejects, the run is stopped
// (status: failed). Below 3, the run stays paused so the user can approve
// or reject again.

import { gql, failRun } from './workflowEngine.js';

const MAX_REJECTS = 3;

export default async function rejectStep(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  const step_run_id = body?.input?.step_run_id || body?.input?.stepRunId;
  const userId = body?.session_variables?.['x-hasura-user-id'];

  if (!userId) {
    return res.status(400).json({ message: 'Unauthorized: No user ID found in session.' });
  }
  if (!step_run_id) {
    return res.status(400).json({ message: 'Bad Request: Missing step_run_id.' });
  }

  try {
    const query = `
      query GetStepRunContext($step_run_id: uuid!, $user_id: uuid!) {
        step_runs_by_pk(id: $step_run_id) {
          id
          status
          workflow_run {
            id
            reject_count
            workflow {
              organization {
                id
                org_members(where: { user_id: { _eq: $user_id } }) {
                  role
                }
              }
            }
          }
        }
      }
    `;
    const data = await gql(query, { step_run_id, user_id: userId });
    const stepRun = data.step_runs_by_pk;

    if (!stepRun) {
      return res.status(400).json({ message: 'Step run not found.' });
    }
    if (stepRun.status !== 'paused') {
      return res.status(400).json({ message: `Step is not awaiting approval (status: ${stepRun.status}).` });
    }

    const workflowRun = stepRun.workflow_run;
    const members = workflowRun.workflow.organization.org_members || [];

    if (members.length === 0) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this organization.' });
    }
    if (members[0].role === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot reject workflow steps.' });
    }

    const newRejectCount = (workflowRun.reject_count ?? 0) + 1;

    if (newRejectCount >= MAX_REJECTS) {
      // 3 strikes: stop the whole run. Mark the step_run itself as failed too,
      // so the frontend timeline shows exactly where and why it stopped.
      await gql(
        `mutation MarkStepRejectedFinal($id: uuid!, $rejected_by: uuid!) {
          update_step_runs_by_pk(
            pk_columns: { id: $id }
            _set: { status: "failed", error: "Rejected 3 times — run stopped.", approved_by: $rejected_by, approved_at: "now()", finished_at: "now()" }
          ) { id }
        }`,
        { id: step_run_id, rejected_by: userId }
      );
      await gql(
        `mutation SetRejectCount($run_id: uuid!, $count: Int!) {
          update_workflow_runs_by_pk(pk_columns: { id: $run_id }, _set: { reject_count: $count }) { id }
        }`,
        { run_id: workflowRun.id, count: newRejectCount }
      );
      await failRun(workflowRun.id);

      return res.status(200).json({
        success: true,
        workflow_run_id: workflowRun.id,
        status: 'failed',
        reject_count: newRejectCount
      });
    }

    // Below the limit: bump the counter, leave the step paused so the user
    // can decide again. The step's own error field carries a visible
    // "rejected (n/3)" note without changing its status.
    await gql(
      `mutation SetRejectCount($run_id: uuid!, $count: Int!) {
        update_workflow_runs_by_pk(pk_columns: { id: $run_id }, _set: { reject_count: $count }) { id }
      }`,
      { run_id: workflowRun.id, count: newRejectCount }
    );
    await gql(
      `mutation NoteReject($id: uuid!, $note: String!) {
        update_step_runs_by_pk(pk_columns: { id: $id }, _set: { error: $note }) { id }
      }`,
      { id: step_run_id, note: `Rejected (${newRejectCount}/${MAX_REJECTS})` }
    );

    return res.status(200).json({
      success: true,
      workflow_run_id: workflowRun.id,
      status: 'paused',
      reject_count: newRejectCount
    });
  } catch (error) {
    console.error('Reject step failed:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
}