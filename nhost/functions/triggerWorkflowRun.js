//import 'dotenv/config';

export default async function triggerWorkflowRun(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // Your Nhost GraphQL Endpoint and Admin Secret

  const GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL || 'https://dhvcevimcsijoxrocwet.graphql.ap-south-1.nhost.run/v1';
  const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || 'piyush12345';

  try {
    const { workflow_id } = body?.input?.workflow_id || body?.input?.workflowId || body?.workflow_id;
    const userId = req.body?.session_variables?.['x-hasura-user-id'];

    if (!userId) {
      return res.status(400).json({ message: 'Unauthorized: No user ID found in session.' });
    }

    if (!workflow_id) {
      return res.status(400).json({ message: 'Bad Request: Missing workflow_id.' });
    }

    // STEP 1: Fetch Workflow, Org details, and User Role
    const checkQuery = `
      query GetWorkflowData($workflow_id: uuid!, $user_id: uuid!) {
        workflows_by_pk(id: $workflow_id) {
          id
          organization {
            id
            quota_limit
            quota_used
            org_members(where: {user_id: {_eq: $user_id}}) {
              role
            }
          }
          workflow_steps(order_by: {step_order: asc}) {
            id
            step_order
            type
            config
          }
        }
      }
    `;

    const checkResponse = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': ADMIN_SECRET
      },
      body: JSON.stringify({
        query: checkQuery,
        variables: { workflow_id, user_id: userId }
      })
    });

    const checkData = await checkResponse.json();

    if (checkData.errors) {
      console.error('GraphQL Query Errors:', checkData.errors);
      return res.status(400).json({ message: checkData.errors[0].message });
    }

    const workflow = checkData.data?.workflows_by_pk;

    if (!workflow) {
      return res.status(400).json({ message: 'Workflow not found' });
    }

    const org = workflow.organization;
    const members = org.org_members || [];

    // STEP 2: Layer 2 Permission Check
    if (members.length === 0) {
      return res.status(400).json({ message: 'Forbidden: You are not a member of this organization.' });
    }

    const userRole = members[0].role;
    if (userRole === 'viewer') {
      return res.status(400).json({ message: 'Forbidden: Viewers cannot trigger workflow runs.' });
    }

    // STEP 3: Quota Check
    if (org.quota_used >= org.quota_limit) {
      return res.status(400).json({ message: 'Payment Required: Organization quota exceeded.' });
    }

    // STEP 4: Create the Workflow Run
    const insertRunMutation = `
      mutation CreateRun($workflow_id: uuid!, $triggered_by: uuid!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          triggered_by: $triggered_by,
          trigger_type: "manual",
          status: "running"
        }) {
          id
        }
      }
    `;

    const runResponse = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': ADMIN_SECRET
      },
      body: JSON.stringify({
        query: insertRunMutation,
        variables: { workflow_id, triggered_by: userId }
      })
    });

    const runData = await runResponse.json();
    const workflowRunId = runData.data?.insert_workflow_runs_one?.id;

    if (!workflowRunId) {
      return res.status(400).json({ message: 'Failed to create workflow run in database.'});
    }
    // STEP 5: Execute Steps (Synchronous skeleton)
    // In a production app with heavy LLM calls, you might push this to a background queue.
    // For this assignment, executing sequentially and pausing on approval_gate is perfect.
    
    let isPaused = false;

    for (const step of workflow.workflow_steps || []) {
      console.log(`Executing step ${step.step_order} of type ${step.type}`);
      
      if (step.type === 'approval_gate') {
        isPaused = true;
        console.log('Approval gate reached. Pausing run.');
        
        // Update run status to 'paused'
        await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-hasura-admin-secret': ADMIN_SECRET
          },
          body: JSON.stringify({
            query: `
              mutation PauseRun($run_id: uuid!, $step_order: Int!) {
                update_workflow_runs_by_pk(
                  pk_columns: {id: $run_id}, 
                  _set: {status: "paused", current_step_order: $step_order}
                ) { id }
              }
            `,
            variables: { run_id: workflowRunId, step_order: step.step_order }
          })
        });
        
        // Break the Loop
        break; 
      }
      
      // Simulate real execution for other steps (LLM call, API hit, etc.)
      // Example: if (step.type === 'llm_call') { await callGroqAPI(step.config); }
    }

    // STEP 6: Completion Check
    if (!isPaused) {
      // If we got through all steps without pausing, marking run as completed and increment the quota
      await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': ADMIN_SECRET
        },
        body: JSON.stringify({
          query: `
            mutation CompleteRun($run_id: uuid!, $org_id: uuid!) {
              update_workflow_runs_by_pk(pk_columns: {id: $run_id}, _set: {status: "completed"}) { id }
              update_organizations_by_pk(pk_columns: {id: $org_id}, _inc: {quota_used: 1}) { id }
            }
          `,
          variables: { run_id: workflowRunId, org_id: org.id }
        })
      });
    }

    // 7. Return success to Hasura
    return res.status(200).json({
      success: true,
      workflow_run_id: workflowRunId,
      status: isPaused ? "paused" : "completed"
    });

  } catch (error) {
    console.error('Workflow trigger failed:', error);
    return res.status(500).json({ 
      message: 'Internal server error', 
      error: error.message 
    });
  }
}