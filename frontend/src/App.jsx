import WorkflowRunner from './WorkflowRunner';

function App() {
  // Grab a real Workflow ID from your Hasura database and paste it here!
  const testWorkflowId = "33333333-3333-4333-8333-333333333333";

  return (
    <div>
      <h1>AI Workflow Dashboard</h1>
      <WorkflowRunner workflowId={testWorkflowId} />
    </div>
  );
}

export default App;