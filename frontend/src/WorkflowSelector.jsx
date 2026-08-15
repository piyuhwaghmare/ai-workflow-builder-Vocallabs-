import { gql } from '@apollo/client/core';
import { useQuery } from '@apollo/client/react';
import './WorkflowSelector.css';

// Permissions already scope this to workflows the signed-in user's org(s)
// grant them access to (see workflows SELECT permission, Layer 1). No org_id
// filter needed here — Hasura does that server-side based on the JWT.
const MY_WORKFLOWS = gql`
  query MyWorkflows {
    workflows(order_by: { name: asc }) {
      id
      name
      description
      organization {
        name
      }
    }
  }
`;

export default function WorkflowSelector({ selectedId, onSelect }) {
  const { data, loading, error } = useQuery(MY_WORKFLOWS);

  if (loading) return <p className="selector-status">Loading your workflows…</p>;
  if (error) return <p className="selector-status selector-status--error">Couldn't load workflows: {error.message}</p>;

  const workflows = data?.workflows ?? [];

  if (workflows.length === 0) {
    return <p className="selector-status">No workflows visible — you may not belong to an organization with any yet.</p>;
  }

  return (
    <div className="workflow-selector">
      <p className="selector-label">Your workflows</p>
      <div className="selector-list">
        {workflows.map((wf) => (
          <button
            key={wf.id}
            className={`selector-item ${wf.id === selectedId ? 'selector-item--active' : ''}`}
            onClick={() => onSelect(wf.id)}
          >
            <span className="selector-item-name">{wf.name}</span>
            <span className="selector-item-org">{wf.organization?.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}