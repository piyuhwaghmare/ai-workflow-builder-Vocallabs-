// triggerWorkflowRun.js
// Hasura Action handler: POST /triggerWorkflowRun
// Verifies caller role (owner/editor only), checks quota, creates a workflow_run,
// then hands off execution to the shared engine.

import { gql, executeStepsFrom } from './workflowEngine.js';

export default async function triggerWorkflowRun(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  const workflow_id = body?.input?.workflow_id || body?.input?.workflowId;
  const trigger_type = body?.input?.trigger_type || 'manual';
  const userId = body?.session_variables?.['x-hasura-user-id'];

  if (!userId) {
    return res.status(400).json({ message: 'Unauthorized: No user ID found in session.' });
  }
  if (!workflow_id) {
    return res.status(400).json({ message: 'Bad Request: Missing workflow_id.' });
  }

  try {
    // STEP 1: Fetch workflow, org, caller's role, and steps
    const checkQuery = `
      query GetWorkflowData($workflow_id: uuid!, $user_id: uuid!) {
        workflows_by_pk(id: $workflow_id) {
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
    `;
    const checkData = await gql(checkQuery, { workflow_id, user_id: userId });
    const workflow = checkData.workflows_by_pk;

    if (!workflow) {
      return res.status(400).json({ message: 'Workflow not found' });
    }

    const org = workflow.organization;
    const members = org.org_members || [];

    // STEP 2: Layer 2 permission check — owner/editor only, not viewer
    if (members.length === 0) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this organization.' });
    }
    const userRole = members[0].role;
    if (userRole === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot trigger workflow runs.' });
    }

    // STEP 3: Quota check
    if (org.quota_used >= org.quota_limit) {
      return res.status(402).json({ message: 'Organization quota exceeded.' });
    }

    // STEP 4: Create the workflow_run
    const insertRunMutation = `
      mutation CreateRun($workflow_id: uuid!, $triggered_by: uuid!, $trigger_type: String!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          triggered_by: $triggered_by,
          trigger_type: $trigger_type,
          status: "running"
        }) { id }
      }
    `;
    const runData = await gql(insertRunMutation, { workflow_id, triggered_by: userId, trigger_type });
    const workflowRunId = runData.insert_workflow_runs_one?.id;
    if (!workflowRunId) {
      return res.status(500).json({ message: 'Failed to create workflow run.' });
    }

    // STEP 5: Execute steps from the beginning
    const steps = workflow.workflow_steps || [];
    const result = await executeStepsFrom({
      steps,
      startIndex: 0,
      workflowRunId,
      org,
      previousOutput: null
    });

    return res.status(200).json({
      success: true,
      workflow_run_id: workflowRunId,
      status: result.status
    });
  } catch (error) {
    console.error('Workflow trigger failed:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
}