import { useAuth } from './AuthProvider';
import SignIn from './SignIn';
import WorkflowRunner from './WorkflowRunner';
import './App.css';

// Swap this for a real workflow selector once you have a list screen —
// for now it's the one you're demoing against.
const testWorkflowId = '1ee438ed-5a6e-478c-9620-ac41f5848fe3';

export default function App() {
  const { isAuthenticated, user, signOut } = useAuth();

  if (!isAuthenticated) {
    return <SignIn />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-eyebrow">AI Workflow Dashboard</p>
          <h1 className="app-title">Signed in as {user?.email}</h1>
        </div>
        <button className="app-signout" onClick={() => signOut()}>
          Sign out
        </button>
      </header>

      <main className="app-main">
        <WorkflowRunner workflowId={testWorkflowId} />
      </main>
    </div>
  );
}