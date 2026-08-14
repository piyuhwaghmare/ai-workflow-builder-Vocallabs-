// Import gql from the core logic
import { gql } from '@apollo/client/core'; 
// Import useMutation directly from the React hooks folder
import { useMutation } from '@apollo/client/react';

const TRIGGER_WORKFLOW_MUTATION = gql`
  mutation TriggerWorkflow($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      success
      status
      workflow_run_id
    }
  }
`;

export default function WorkflowRunner({ workflowId }) {
  const [triggerWorkflow, { data, loading, error }] = useMutation(TRIGGER_WORKFLOW_MUTATION);

  const handleRunClick = async () => {
    try {
      await triggerWorkflow({
        variables: { workflow_id: workflowId },
      });
      alert("Workflow started successfully!");
    } catch (err) {
      alert("Failed: " + err.message);
    }
  };

  return (
    <div style={{ padding: '20px', border: '1px solid #ccc', borderRadius: '8px', margin: '20px' }}>
      <h3>Run this Workflow</h3>
      <button onClick={handleRunClick} disabled={loading}>
        {loading ? 'Starting...' : '▶ Run Workflow'}
      </button>
      {data?.triggerWorkflowRun?.success && (
        <p>Status: <strong>{data.triggerWorkflowRun.status}</strong></p>
      )}
    </div>
  );
}