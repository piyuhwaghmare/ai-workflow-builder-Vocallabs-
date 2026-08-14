export default async function triggerWorkflowRun(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // 1. Parse body safely
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  // 2. Extract values directly (NO destructuring syntax)
  const workflow_id = body?.input?.workflow_id || body?.input?.workflowId || body?.workflow_id;
  const userId = body?.session_variables?.['x-hasura-user-id'] || 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  // 3. Validation check
  if (!workflow_id) {
    return res.status(400).json({ message: 'Bad Request: Missing workflow_id.' });
  }

  // 4. Instant static response to confirm endpoint works
  return res.status(200).json({
    success: true,
    workflow_run_id: '44444444-4444-4444-4444-444444444444',
    status: 'completed'
  });
}