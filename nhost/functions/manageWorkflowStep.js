// manageWorkflowStep.js
// Hasura Action handler: POST /manageWorkflowStep
// Input: { workflow_id, step_order, type, config, step_id? }
// If step_id is provided, updates that step. Otherwise inserts a new one.
//
// Layer 2 (step-level gating): db_write and notify steps reach outside the
// sandbox (writing data, sending external alerts) and are restricted to
// owners only — this can't be a plain Hasura permission because it depends
// on the VALUE of the "type" column being written, combined with the
// caller's role, which is exactly the kind of decision the spec says
// belongs in the Action handler, not the database permission layer.

import { gql } from './workflowEngine.js';

const OWNER_ONLY_TYPES = ['db_write', 'notify'];
const ALL_TYPES = ['llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate'];

export default async function manageWorkflowStep(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  const { workflow_id, step_order, type, config, step_id } = body?.input || {};
  const userId = body?.session_variables?.['x-hasura-user-id'];

  if (!userId) {
    return res.status(400).json({ message: 'Unauthorized: No user ID found in session.' });
  }
  if (!workflow_id || !step_order || !type) {
    return res.status(400).json({ message: 'Bad Request: Missing workflow_id, step_order, or type.' });
  }
  if (!ALL_TYPES.includes(type)) {
    return res.status(400).json({ message: `Bad Request: Unknown step type "${type}".` });
  }

  try {
    // Fetch the caller's role in the workflow's org
    const query = `
      query GetRole($workflow_id: uuid!, $user_id: uuid!) {
        workflows_by_pk(id: $workflow_id) {
          id
          organization {
            org_members(where: { user_id: { _eq: $user_id } }) {
              role
            }
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

    // Layer 1 equivalent inside the handler: viewers can't touch steps at all
    if (role === 'viewer') {
      return res.status(403).json({ message: 'Forbidden: Viewers cannot modify workflow steps.' });
    }

    // Layer 2: only owners may add/edit db_write or notify steps
    if (OWNER_ONLY_TYPES.includes(type) && role !== 'owner') {
      return res.status(403).json({
        message: `Forbidden: Only an org owner can add or edit a "${type}" step.`
      });
    }

    if (step_id) {
      const updateMutation = `
        mutation UpdateStep($id: uuid!, $set: workflow_steps_set_input!) {
          update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: $set) { id }
        }
      `;
      await gql(updateMutation, { id: step_id, set: { step_order, type, config } });
      return res.status(200).json({ success: true, step_id });
    }

    const insertMutation = `
      mutation InsertStep($object: workflow_steps_insert_input!) {
        insert_workflow_steps_one(object: $object) { id }
      }
    `;
    const result = await gql(insertMutation, {
      object: { workflow_id, step_order, type, config: config ?? {} }
    });

    return res.status(200).json({ success: true, step_id: result.insert_workflow_steps_one.id });
  } catch (error) {
    console.error('manageWorkflowStep failed:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
}