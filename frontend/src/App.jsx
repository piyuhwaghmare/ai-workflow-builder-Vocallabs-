import { useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import SignIn from './SignIn';
import Header from './Header';
import WorkflowSelector from './WorkflowSelector';
import WorkflowRunner from './WorkflowRunner';
import './App.css';

export default function App() {
  const { isAuthenticated, user, signOut } = useAuth();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);

  // A stale selection from a previous session shouldn't carry into the next
  // login — especially across different users/orgs.
  useEffect(() => {
    if (!isAuthenticated) setSelectedWorkflowId(null);
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return <SignIn />;
  }

  return (
    <div className="app-shell">
      <Header email={user?.email} onSignOut={signOut} />

      <main className="app-main-column">
        <WorkflowSelector selectedId={selectedWorkflowId} onSelect={setSelectedWorkflowId} />
        {selectedWorkflowId ? (
          <WorkflowRunner workflowId={selectedWorkflowId} />
        ) : (
          <p className="selector-status">Pick a workflow above to run it.</p>
        )}
      </main>
    </div>
  );
}