// resolveBranch.js
// Hasura Action handler: POST /resolveBranch
// Input: { step_run_id, decision }  -- decision is "ok" or "reject"
// Called when a conditional_branch evaluated false and paused the run
// (see workflowEngine.js). EITHER decision resumes execution at the next
// step — this action never stops the workflow, it only records which
// choice the user made and moves on. Same Layer 2 org-role check pattern
// as approveStep.js / rejectStep.js.

import { gql, resumeRun, executeStepsFrom } from './workflowEngine.js';

export default async function resolveBranch(req, res) {
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
  const decision = body?.input?.decision;
  const userId = body?.session_variables?.['x-hasura-user-id'];

  if (!userId) {
    return res.status(400).json({ message: 'Unauthorized: No user ID found in session.' });
  }
  if (!step_run_id || !['ok', 'reject'].includes(decision)) {
    return res.status(400).json({ message: 'Bad Request: Missing step_run_id or invalid decision (must be "ok" or "reject").' });
  }

  try {
    const query = `
      query GetBranchContext($step_run_id: uuid!, $user_id: uuid!) {
        step_runs_by_pk(id: $step_run_id) {
          id
          type
          status
          step_order
          output
          error
          workflow_run {
            id
            status
            workflow {
              id
              organization {
                id
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
    if (stepRun.type !== 'conditional_branch') {
      return res.status(400).json({ message: 'This step is not a conditional_branch.' });
    }
    const workflowRun = stepRun.workflow_run;
    if (workflowRun.status !== 'paused') {
      return res.status(400).json({ message: `Run is not paused (status: ${workflowRun.status}).` });
    }
    if (stepRun.error) {
      return res.status(400).json({ message: 'This branch has already been resolved.' });
    }

    const workflow = workflowRun.workflow;
    const org = workflow.organization;
    const members = org.org_members || [];

    if (members.length === 0) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this organization.' });
    }
    if (members[0].role === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot resolve workflow decisions.' });
    }

    // Record which choice was made. Both choices continue execution — the
    // message just documents intent for the run history / recording.
    const note = decision === 'reject'
      ? 'I cannot perform this one — continuing to next step.'
      : 'Acknowledged — continuing to next step.';

    await gql(
      `mutation NoteBranchDecision($id: uuid!, $note: String!) {
        update_step_runs_by_pk(pk_columns: { id: $id }, _set: { error: $note }) { id }
      }`,
      { id: step_run_id, note }
    );

    // Resume the run and continue to the step AFTER the branch, carrying the
    // branch's own output forward (same as approveStep.js does for gates).
    await resumeRun(workflowRun.id);

    const steps = workflow.workflow_steps || [];
    const resumeIndex = steps.findIndex((s) => s.step_order === stepRun.step_order) + 1;

    const result = await executeStepsFrom({
      steps,
      startIndex: resumeIndex,
      workflowRunId: workflowRun.id,
      org,
      previousOutput: stepRun.output
    });

    return res.status(200).json({
      success: true,
      workflow_run_id: workflowRun.id,
      status: result.status,
      decision
    });
  } catch (error) {
    console.error('Resolve branch failed:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
}