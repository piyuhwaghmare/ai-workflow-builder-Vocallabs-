import { useState } from 'react';
import { gql } from '@apollo/client/core'; 
import { useMutation } from '@apollo/client/react';

// 1. Trigger Mutation
const TRIGGER_WORKFLOW_MUTATION = gql`
  mutation TriggerWorkflow($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      success
      status
      workflow_run_id
    }
  }
`;

// 2. Approve/Reject Mutation
const APPROVE_WORKFLOW_MUTATION = gql`
  mutation ApproveWorkflowRun($workflow_run_id: uuid!, $approved: Boolean!) {
    approveWorkflowRun(workflow_run_id: $workflow_run_id, approved: $approved) {
      success
      status
      message
    }
  }
`;

export default function WorkflowRunner({ workflowId }) {
  const [runState, setRunState] = useState({ runId: null, status: null });

  const [triggerWorkflow, { loading: triggerLoading }] = useMutation(TRIGGER_WORKFLOW_MUTATION);
  const [approveWorkflow, { loading: approveLoading }] = useMutation(APPROVE_WORKFLOW_MUTATION);

  // Handle Initial Run
  const handleRunClick = async () => {
    try {
      const response = await triggerWorkflow({
        variables: { workflow_id: workflowId },
      });
      const res = response.data.triggerWorkflowRun;
      setRunState({ runId: res.workflow_run_id, status: res.status });
    } catch (err) {
      alert("Failed to start: " + err.message);
    }
  };

  // Handle Human Approval Gate
  const handleApproval = async (isApproved) => {
    try {
      const response = await approveWorkflow({
        variables: { workflow_run_id: runState.runId, approved: isApproved },
      });
      const res = response.data.approveWorkflowRun;
      setRunState((prev) => ({ ...prev, status: res.status }));
    } catch (err) {
      alert("Action failed: " + err.message);
    }
  };

  return (
    <div style={{ padding: '20px', border: '1px solid #ccc', borderRadius: '8px', margin: '20px', maxWidth: '400px' }}>
      <h3>Run this Workflow</h3>

      {/* Start Button */}
      <button onClick={handleRunClick} disabled={triggerLoading}>
        {triggerLoading ? 'Starting...' : '▶ Run Workflow'}
      </button>

      {/* Status Badges & Approval Controls */}
      {runState.status && (
        <div style={{ marginTop: '15px' }}>
          <p>Status: <strong>{runState.status.toUpperCase()}</strong></p>

          {/* Conditional Approval UI when status is 'paused' */}
          {runState.status === 'paused' && (
            <div style={{ border: '1px solid #f59e0b', padding: '10px', borderRadius: '6px', backgroundColor: '#fffbeb' }}>
              <p style={{ margin: '0 0 10px 0', color: '#b45309' }}>⚠️ Approval Gate Reached</p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button 
                  onClick={() => handleApproval(true)} 
                  disabled={approveLoading}
                  style={{ backgroundColor: '#16a34a', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '4px', cursor: 'pointer' }}
                >
                  ✓ Approve (Green Mark)
                </button>
                <button 
                  onClick={() => handleApproval(false)} 
                  disabled={approveLoading}
                  style={{ backgroundColor: '#dc2626', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '4px', cursor: 'pointer' }}
                >
                  ✕ Reject
                </button>
              </div>
            </div>
          )}

          {/* Final Status Display */}
          {runState.status === 'completed' && (
            <p style={{ color: '#16a34a', fontWeight: 'bold' }}>✅ Workflow Execution Completed!</p>
          )}
          {runState.status === 'failed' && (
            <p style={{ color: '#dc2626', fontWeight: 'bold' }}>❌ Workflow Execution Rejected / Failed</p>
          )}
        </div>
      )}
    </div>
  );
}