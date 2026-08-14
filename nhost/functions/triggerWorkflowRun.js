// triggerWorkflowRun.js
// Hasura Action handler: POST /triggerWorkflowRun
// CHANGED: this now ONLY verifies role + quota and creates the workflow_run row.
// It does NOT execute steps anymore — that's executeWorkflowRun.js.
// Why: the old version awaited the entire step loop before responding, so by
// the time the frontend got a run_id and mounted its subscription, the run
// had already finished. Splitting the call in two gives the frontend a window
// to subscribe WHILE execution is still happening.

import { gql } from './workflowEngine.js';

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

    if (members.length === 0) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this organization.' });
    }
    const userRole = members[0].role;
    if (userRole === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot trigger workflow runs.' });
    }

    if (org.quota_used >= org.quota_limit) {
      return res.status(402).json({ message: 'Organization quota exceeded.' });
    }

    // Status starts as "pending" — executeWorkflowRun flips it to "running"
    // right before the first step, which the subscription WILL catch.
    const insertRunMutation = `
      mutation CreateRun($workflow_id: uuid!, $triggered_by: uuid!, $trigger_type: String!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          triggered_by: $triggered_by,
          trigger_type: $trigger_type,
          status: "pending"
        }) { id }
      }
    `;
    const runData = await gql(insertRunMutation, { workflow_id, triggered_by: userId, trigger_type });
    const workflowRunId = runData.insert_workflow_runs_one?.id;
    if (!workflowRunId) {
      return res.status(500).json({ message: 'Failed to create workflow run.' });
    }

    return res.status(200).json({
      success: true,
      workflow_run_id: workflowRunId,
      status: 'pending'
    });
  } catch (error) {
    console.error('Workflow trigger failed:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
}