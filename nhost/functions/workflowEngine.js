// workflowEngine.js
// Shared logic used by BOTH Action handlers: triggerWorkflowRun.js and approveStep.js
// Keeping this in one place means "resume after approval" behaves identically to
// "run from the start" — same retry rules, same step_runs bookkeeping, same quota logic.

const GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL;
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET;

if (!GRAPHQL_URL || !ADMIN_SECRET) {
  throw new Error('Missing required environment variables: NHOST_GRAPHQL_URL or NHOST_ADMIN_SECRET');
}

// ---------- GraphQL helper ----------
export async function gql(query, variables) {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await resp.json();
  if (data.errors) {
    console.error('GraphQL error:', JSON.stringify(data.errors));
    throw new Error(data.errors[0].message);
  }
  return data.data;
}

// ---------- step_runs helpers ----------
export async function createStepRun(workflowRunId, step, input) {
  const mutation = `
    mutation CreateStepRun($object: step_runs_insert_input!) {
      insert_step_runs_one(object: $object) { id }
    }
  `;
  const data = await gql(mutation, {
    object: {
      workflow_run_id: workflowRunId,
      workflow_step_id: step.id,
      step_order: step.step_order,
      type: step.type,
      status: 'running',
      input: input ?? {},
      started_at: new Date().toISOString(),
      attempt_count: 0
    }
  });
  return data.insert_step_runs_one.id;
}

export async function finishStepRun(stepRunId, { status, output, error, attemptCount }) {
  const mutation = `
    mutation FinishStepRun($id: uuid!, $set: step_runs_set_input!) {
      update_step_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }
  `;
  await gql(mutation, {
    id: stepRunId,
    set: {
      status,
      output: output ?? null,
      error: error ?? null,
      attempt_count: attemptCount,
      finished_at: new Date().toISOString()
    }
  });
}

export async function pauseRunAt(workflowRunId, stepOrder) {
  const mutation = `
    mutation PauseRun($run_id: uuid!, $step_order: Int!) {
      update_workflow_runs_by_pk(
        pk_columns: { id: $run_id }
        _set: { status: "paused", current_step_order: $step_order }
      ) { id }
    }
  `;
  await gql(mutation, { run_id: workflowRunId, step_order: stepOrder });
}

export async function resumeRun(workflowRunId) {
  const mutation = `
    mutation ResumeRun($run_id: uuid!) {
      update_workflow_runs_by_pk(
        pk_columns: { id: $run_id }
        _set: { status: "running" }
      ) { id }
    }
  `;
  await gql(mutation, { run_id: workflowRunId });
}

export async function completeRun(workflowRunId, orgId, callsMade) {
  const mutation = `
    mutation CompleteRun($run_id: uuid!, $org_id: uuid!, $inc: Int!) {
      update_workflow_runs_by_pk(
        pk_columns: { id: $run_id }
        _set: { status: "completed", finished_at: "now()" }
      ) { id }
      update_organizations_by_pk(
        pk_columns: { id: $org_id }
        _inc: { quota_used: $inc }
      ) { id }
    }
  `;
  await gql(mutation, { run_id: workflowRunId, org_id: orgId, inc: callsMade });
}

export async function failRun(workflowRunId) {
  const mutation = `
    mutation FailRun($run_id: uuid!) {
      update_workflow_runs_by_pk(
        pk_columns: { id: $run_id }
        _set: { status: "failed", finished_at: "now()" }
      ) { id }
    }
  `;
  await gql(mutation, { run_id: workflowRunId });
}

// ---------- per-step-type execution ----------
// Returns { output, callMade } — callMade=true counts against org quota (llm_call / http_request only)
export async function runStepLogic(step, previousOutput) {
  switch (step.type) {
    case 'llm_call': {
      const prompt = (step.config?.prompt || '{{input}}').replace(
        '{{input}}',
        JSON.stringify(previousOutput ?? {})
      );

      if (process.env.GROQ_API_KEY) {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: step.config?.model || 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }]
          })
        });
        if (!resp.ok) throw new Error(`LLM API error: ${resp.status}`);
        const json = await resp.json();
        const text = json.choices?.[0]?.message?.content ?? '';
        return { output: { text }, callMade: true };
      }

      // Stubbed fallback — disclosed artificial delay, per assignment rules.
      await new Promise((r) => setTimeout(r, 1000));
      return { output: { text: `[stubbed llm response] ${prompt}` }, callMade: true };
    }

    case 'http_request': {
      const { url, method = 'GET', headers = {}, body } = step.config || {};
      if (!url) throw new Error('http_request step missing config.url');
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
      if (!resp.ok) throw new Error(`HTTP request failed: ${resp.status}`);
      const json = await resp.json().catch(() => ({}));
      return { output: json, callMade: true };
    }

    case 'db_write': {
      return { output: { saved: true, data: previousOutput ?? null }, callMade: false };
    }

    case 'notify': {
      // Real delivery (Slack/email) is handled by a Hasura Event Trigger watching
      // inserts on step_runs where type = 'notify' — this just records the intent.
      return { output: { notified: true, channel: step.config?.slack_channel ?? null }, callMade: false };
    }

    case 'conditional_branch': {
      const condition = step.config?.condition;
      const result = evaluateCondition(condition, previousOutput);
      return { output: { condition, result }, callMade: false };
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function evaluateCondition(condition, previousOutput) {
  if (!condition) return true;
  const eqMatch = condition.split('==').map((s) => s.trim());
  if (eqMatch.length === 2) {
    const [field, expected] = eqMatch;
    return String(previousOutput?.[field]) === expected;
  }
  const neqMatch = condition.split('!=').map((s) => s.trim());
  if (neqMatch.length === 2) {
    const [field, expected] = neqMatch;
    return String(previousOutput?.[field]) !== expected;
  }
  return true;
}

// ---------- the shared execution loop ----------
// Runs steps starting at startIndex (0-based) in `steps`. Used both for a fresh run
// (startIndex = 0) and for resuming after an approval_gate (startIndex = gate + 1).
// `previousOutput` should be the output of the step immediately before startIndex
// (null if starting from the very first step).
export async function executeStepsFrom({ steps, startIndex, workflowRunId, org, previousOutput }) {
  let callsMade = 0;
  let isPaused = false;
  let isFailed = false;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    const stepRunId = await createStepRun(workflowRunId, step, previousOutput);

    if (step.type === 'approval_gate') {
      await pauseRunAt(workflowRunId, step.step_order);
      await finishStepRun(stepRunId, { status: 'paused', output: null, error: null, attemptCount: 0 });
      isPaused = true;
      break;
    }

    const maxAttempts = (step.type === 'llm_call' || step.type === 'http_request') ? 2 : 1;
    let attempt = 0;
    let output = null;
    let lastError = null;
    let callMade = false;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const result = await runStepLogic(step, previousOutput);
        output = result.output;
        callMade = result.callMade;
        lastError = null;
        break;
      } catch (e) {
        lastError = e.message;
      }
    }

    if (lastError) {
      await finishStepRun(stepRunId, { status: 'failed', output: null, error: lastError, attemptCount: attempt });
      await failRun(workflowRunId);
      isFailed = true;
      break;
    }

    await finishStepRun(stepRunId, { status: 'completed', output, error: null, attemptCount: attempt });
    if (callMade) callsMade++;
    previousOutput = output;

    if (step.type === 'conditional_branch' && output?.result === false) {
      break;
    }
  }

  if (!isPaused && !isFailed) {
    await completeRun(workflowRunId, org.id, callsMade);
  }

  return {
    status: isPaused ? 'paused' : isFailed ? 'failed' : 'completed'
  };
}