// resolveBranch.js
// Hasura Action handler: POST /resolveBranch
// Input: { step_run_id, decision }  -- decision is "ok" or "reject"
// Called when a conditional_branch evaluated false and paused the run
// (see workflowEngine.js).
//
// CHANGED BEHAVIOR:
// - "ok" (Approve): the false condition is ignored — execution resumes and
//   continues through the rest of the workflow normally.
// - "reject": this is now a deliberate STOP. The run ends right here and is
//   marked "completed" (not "failed") with exactly the steps that already
//   ran — no further steps are created or executed. This is treated as a
//   legitimate, user-chosen stopping point, not an error state.
//
// Same Layer 2 org-role check pattern as approveStep.js / rejectStep.js.

import { gql, completeRun, resumeRun, executeStepsFrom } from './workflowEngine.js';

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

    // ---- Approve: ignore the flagged result, keep executing normally ----
    if (decision === 'ok') {
      await gql(
        `mutation NoteBranchDecision($id: uuid!, $note: String!) {
          update_step_runs_by_pk(pk_columns: { id: $id }, _set: { error: $note }) { id }
        }`,
        { id: step_run_id, note: 'Approved — continuing to next step.' }
      );

      // Resume the run and continue to the step AFTER the branch, carrying
      // the branch's own output forward (same as approveStep.js does for gates).
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
    }

    // ---- Reject: stop the run right here, as a completed run ----
    // No further steps are created. The run is marked "completed" (not
    // "failed") because stopping here was a deliberate human decision, not
    // an error — the frontend distinguishes this case via the branchStop
    // check (a conditional_branch with result === false on a completed run).
    await gql(
      `mutation NoteBranchDecision($id: uuid!, $note: String!) {
        update_step_runs_by_pk(pk_columns: { id: $id }, _set: { error: $note }) { id }
      }`,
      { id: step_run_id, note: 'Rejected — run stopped here by user decision.' }
    );

    // No steps executed since the pause, so no additional quota calls to add.
    await completeRun(workflowRun.id, org.id, 0);

    return res.status(200).json({
      success: true,
      workflow_run_id: workflowRun.id,
      status: 'completed',
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