export default async function triggerWorkflowRun(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // 1. Safe Body Parsing
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const workflow_id = body?.input?.workflow_id || body?.input?.workflowId || body?.workflow_id;
  const userId = body?.session_variables?.['x-hasura-user-id'] || 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  if (!workflow_id) {
    return res.status(400).json({ message: 'Bad Request: Missing workflow_id.' });
  }

  const GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL || 'https://dhvcevimcsijoxrocwet.hasura.ap-south-1.nhost.run/v1/graphql';
  const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || 'piyush12345';

  try {
    // 2. Fetch Workflow Data from Hasura
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
        }
      }
    `;

    const response = await fetch(GRAPHQL_URL, {
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

    const result = await response.json();

    if (result.errors) {
      return res.status(400).json({ message: result.errors[0].message });
    }

    const workflow = result.data?.workflows_by_pk;
    if (!workflow) {
      return res.status(400).json({ message: `Workflow '${workflow_id}' not found in database.` });
    }

    // Return 'validated' status to confirm DB read works
    return res.status(200).json({
      success: true,
      workflow_run_id: '44444444-4444-4444-4444-444444444444',
      status: 'validated'
    });

  } catch (err) {
    return res.status(400).json({ message: `Database error: ${err.message}` });
  }
}