// triggerWebhookRun.js
// Public HTTP endpoint — NOT a Hasura Action, called directly by external
// systems with no login at all. Authorizes via a secret token stored on
// the workflow_triggers row instead of a user role, since there is no
// user in this flow (workflow_runs.triggered_by will be NULL).

import { gql, executeStepsFrom } from './workflowEngine.js';

export default async function triggerWebhookRun(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // Accept the params from either the query string or a JSON body, so a
  // GET-style curl (?workflow_id=...&secret=...) and a JSON-body caller
  // both work without a mismatch.
  let bodyParsed = {};
  try {
    bodyParsed = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    bodyParsed = {};
  }

  const workflow_id = req.query?.workflow_id || bodyParsed.workflow_id;
  const secret = req.query?.secret || req.query?.token || bodyParsed.secret || bodyParsed.token;

  if (!workflow_id || !secret) {
    return res.status(400).json({
      message: 'Bad Request: Missing workflow_id or secret.',
      received: { workflow_id: workflow_id ?? null, secret_present: !!secret, query: req.query, body: bodyParsed }
    });
  }

  try {
    const query = `
      query GetTriggerAndWorkflow($workflow_id: uuid!) {
        workflow_triggers(where: {
          workflow_id: { _eq: $workflow_id },
          type: { _eq: "webhook" },
          is_active: { _eq: true }
        }) {
          id
          config
        }
        workflows_by_pk(id: $workflow_id) {
          id
          organization { id quota_limit quota_used }
          workflow_steps(order_by: { step_order: asc }) { id step_order type config }
        }
      }
    `;
    const data = await gql(query, { workflow_id });
    const trigger = data.workflow_triggers?.[0];
    const workflow = data.workflows_by_pk;

    if (!trigger || !workflow) {
      return res.status(404).json({ message: 'No active webhook trigger found for this workflow.' });
    }

    if (trigger.config?.secret !== secret) {
      // TEMPORARY debug info — remove before final submission. Shows exactly
      // what was compared, since we can't see server console output directly.
      return res.status(403).json({
        message: 'Invalid webhook secret.',
        debug: {
          received_secret: secret,
          received_secret_length: secret?.length,
          stored_secret: trigger.config?.secret,
          stored_secret_length: trigger.config?.secret?.length,
          config_type: typeof trigger.config,
          raw_config: trigger.config
        }
      });
    }

    const org = workflow.organization;
    if (org.quota_used >= org.quota_limit) {
      return res.status(402).json({ message: 'Organization quota exceeded.' });
    }

    const insertRunMutation = `
      mutation CreateRun($workflow_id: uuid!, $trigger_type: String!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          trigger_type: $trigger_type,
          status: "running"
        }) { id }
      }
    `;
    const runData = await gql(insertRunMutation, { workflow_id, trigger_type: 'webhook' });
    const workflowRunId = runData.insert_workflow_runs_one.id;

    const result = await executeStepsFrom({
      steps: workflow.workflow_steps,
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
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
}