// addWorkflowTrigger.js
// Hasura Action handler: POST /addWorkflowTrigger
// Input: { workflow_id, type }  (type: "manual" | "webhook")
//
// Layer 2: only an owner can add a webhook trigger (it's an inbound
// endpoint external systems can call — same "reaches outside the sandbox"
// reasoning as db_write/notify steps). A manual trigger is safe for any
// editor+ to add. If type is "webhook", this also generates and returns
// the secret the caller will need to actually fire it later.

import { gql } from './workflowEngine.js';
import { randomBytes } from 'crypto';

function generateSecret() {
  return randomBytes(24).toString('hex');
}

export default async function addWorkflowTrigger(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  const { workflow_id, type } = body?.input || {};
  const userId = body?.session_variables?.['x-hasura-user-id'];

  if (!userId) {
    return res.status(400).json({ message: 'Unauthorized: No user ID found in session.' });
  }
  if (!workflow_id || !type) {
    return res.status(400).json({ message: 'Bad Request: Missing workflow_id or type.' });
  }
  if (!['manual', 'webhook', 'scheduled', 'database_event'].includes(type)) {
    return res.status(400).json({ message: `Bad Request: Unknown trigger type "${type}".` });
  }

  try {
    const query = `
      query GetRole($workflow_id: uuid!, $user_id: uuid!) {
        workflows_by_pk(id: $workflow_id) {
          id
          organization {
            org_members(where: { user_id: { _eq: $user_id } }) { role }
          }
        }
      }
    `;
    const data = await gql(query, { workflow_id, user_id: userId });
    const workflow = data.workflows_by_pk;
    if (!workflow) {
      return res.status(404).json({ message: 'Workflow not found.' });
    }

    const members = workflow.organization.org_members || [];
    if (members.length === 0) {
      return res.status(403).json({ message: 'Forbidden: You are not a member of this organization.' });
    }
    const role = members[0].role;

    if (role === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot add triggers.' });
    }

    if (type === 'webhook' && role !== 'owner') {
      return res.status(403).json({ message: 'Forbidden: Only an org owner can add a webhook trigger.' });
    }

    const config = type === 'webhook' ? { secret: generateSecret() } : {};

    const insertMutation = `
      mutation InsertTrigger($object: workflow_triggers_insert_input!) {
        insert_workflow_triggers_one(object: $object) { id config }
      }
    `;
    const result = await gql(insertMutation, {
      object: { workflow_id, type, config, is_active: true }
    });

    return res.status(200).json({
      success: true,
      trigger_id: result.insert_workflow_triggers_one.id,
      secret: type === 'webhook' ? config.secret : null
    });
  } catch (error) {
    console.error('addWorkflowTrigger failed:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
}