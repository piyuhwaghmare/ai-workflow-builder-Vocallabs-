const GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL || 'https://dhvcevimcsijoxrocwet.hasura.ap-south-1.nhost.run/v1/graphql';
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || 'piyush12345';

async function gql(query, variables) {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables })
  });
  const data = await resp.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

export default async function approveWorkflowRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const run_id = body?.input?.workflow_run_id;
  const approved = body?.input?.approved ?? true;

  if (!run_id) return res.status(400).json({ message: 'Missing workflow_run_id' });

  try {
    if (!approved) {
      // Rejection branch
      await gql(`
        mutation RejectRun($id: uuid!) {
          update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: { status: "failed" }) { id }
        }
      `, { id: run_id });

      return res.status(200).json({ success: true, status: 'failed', message: 'Workflow run rejected' });
    }

    // Approval branch: Resume run to completed
    await gql(`
      mutation ResumeRun($id: uuid!) {
        update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: { status: "completed" }) { id }
      }
    `, { id: run_id });

    return res.status(200).json({ success: true, status: 'completed', message: 'Workflow run approved and completed' });
  } catch (err) {
    return res.status(400).json({ message: err.message || 'Approval failed' });
  }
}