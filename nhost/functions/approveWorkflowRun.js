// approveStep.js
// Hasura Action handler: POST /approveStep
// Input: { step_run_id }
// Checks the approver's role in the OWNING org (Layer 2), then resumes the run.
// CHANGED: also resets workflow_runs.reject_count to 0 on approval, since the
// "3 rejects in a row" rule (see rejectStep.js) is about a consecutive streak,
// not a lifetime total.

import { gql, resumeRun, executeStepsFrom } from './workflowEngine.js';

export default async function approveStep(req, res) {
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
          step_order
          workflow_run {
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
    const workflow = workflowRun.workflow;
    const org = workflow.organization;
    const members = org.org_members || [];

    // Layer 2 permission check — only owner/editor IN THIS ORG may approve.
    if (members.length === 0) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this organization.' });
    }
    const approverRole = members[0].role;
    if (approverRole === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot approve workflow steps.' });
    }

    // Mark this step_run as approved + completed
    const approveMutation = `
      mutation ApproveStep($id: uuid!, $approved_by: uuid!) {
        update_step_runs_by_pk(
          pk_columns: { id: $id }
          _set: {
            status: "completed"
            approved_by: $approved_by
            approved_at: "now()"
            finished_at: "now()"
          }
        ) { id }
      }
    `;
    await gql(approveMutation, { id: step_run_id, approved_by: userId });

    // Reset the reject streak — an approval breaks any run of consecutive rejects.
    await gql(
      `mutation ResetRejectCount($run_id: uuid!) {
        update_workflow_runs_by_pk(pk_columns: { id: $run_id }, _set: { reject_count: 0 }) { id }
      }`,
      { run_id: workflowRun.id }
    );

    // Flip the run back to "running" and resume execution after this step
    await resumeRun(workflowRun.id);

    const steps = workflow.workflow_steps || [];
    const resumeIndex = steps.findIndex((s) => s.step_order === stepRun.step_order) + 1;

    const result = await executeStepsFrom({
      steps,
      startIndex: resumeIndex,
      workflowRunId: workflowRun.id,
      org,
      previousOutput: null
    });

    return res.status(200).json({
      success: true,
      workflow_run_id: workflowRun.id,
      status: result.status
    });
  } catch (error) {
    console.error('Approve step failed:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
}