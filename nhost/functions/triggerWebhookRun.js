// triggerWebhookRun.js
// Hasura Action handler: POST /triggerWebhookRun
// Input: { workflow_id, secret }
// CALLED BY EXTERNAL SYSTEMS — there is no logged-in user, no JWT, no
// x-hasura-user-id. Authorization here is NOT a role check (there's no one
// to check a role against) — it's a shared secret set on the workflow_triggers
// row when the trigger was created. This is the standard pattern for
// unauthenticated inbound webhooks: the workflow's owner controls who can
// fire it by controlling who they give the secret to.

import { gql, executeStepsFrom } from './workflowEngine.js';

export default async function triggerWebhookRun(req, res) {
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
  const providedSecret = body?.input?.secret;

  if (!workflow_id || !providedSecret) {
    return res.status(400).json({ message: 'Bad Request: Missing workflow_id or secret.' });
  }

  try {
    // Look up the webhook trigger for this workflow AND fetch everything
    // needed to run it, in one query.
    const query = `
      query GetWebhookContext($workflow_id: uuid!) {
        workflow_triggers(
          where: { workflow_id: { _eq: $workflow_id }, type: { _eq: "webhook" }, is_active: { _eq: true } }
        ) {
          id
          config
        }
        workflows_by_pk(id: $workflow_id) {
          id
          organization {
            id
            quota_limit
            quota_used
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
    const data = await gql(query, { workflow_id });

    const trigger = data.workflow_triggers?.[0];
    const workflow = data.workflows_by_pk;

    if (!trigger) {
      return res.status(404).json({ message: 'No active webhook trigger configured for this workflow.' });
    }
    if (!workflow) {
      return res.status(400).json({ message: 'Workflow not found.' });
    }

    // Constant-time-ish comparison isn't critical at this scale, but avoid
    // short-circuiting on the very first mismatched character regardless.
    const storedSecret = trigger.config?.secret;
    if (!storedSecret || providedSecret !== storedSecret) {
      return res.status(403).json({ message: 'Forbidden: Invalid webhook secret.' });
    }

    const org = workflow.organization;
    if (org.quota_used >= org.quota_limit) {
      return res.status(402).json({ message: 'Organization quota exceeded.' });
    }

    // triggered_by is intentionally NULL — there is no user for a webhook call.
    const insertRunMutation = `
      mutation CreateRun($workflow_id: uuid!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          triggered_by: null,
          trigger_type: "webhook",
          status: "running"
        }) { id }
      }
    `;
    const runData = await gql(insertRunMutation, { workflow_id });
    const workflowRunId = runData.insert_workflow_runs_one?.id;
    if (!workflowRunId) {
      return res.status(500).json({ message: 'Failed to create workflow run.' });
    }

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
    console.error('Webhook trigger failed:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
}