// workflowEngine.js  (DEBUG BUILD — traces execution into workflow_runs.debug_log
// so it's visible live on the FRONTEND, since server console logs aren't reachable
// right now. Once the bug is found, swap back to the clean version — this build
// does extra DB writes purely for tracing and isn't meant to stay in production.)
//
// Requires: ALTER TABLE workflow_runs ADD COLUMN debug_log text DEFAULT '';
// and debug_log exposed in select permissions for every role.

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

// ---------- debug trace helper ----------
// Writes the full accumulated log (as one text blob) into workflow_runs.debug_log.
// The frontend subscription picks this up live, same as any other column change.
// Failures here are swallowed (never let tracing break the actual run).
async function flushDebug(workflowRunId, lines) {
  if (!workflowRunId) return;
  const text = lines.join('\n');
  try {
    await gql(
      `mutation SetDebugLog($run_id: uuid!, $log: String!) {
        update_workflow_runs_by_pk(pk_columns: { id: $run_id }, _set: { debug_log: $log }) { id }
      }`,
      { run_id: workflowRunId, log: text }
    );
  } catch (e) {
    console.error('[flushDebug] failed to write debug_log:', e.message);
  }
}

function makeLogger(workflowRunId) {
  const lines = [];
  return {
    lines,
    async log(msg) {
      const stamp = new Date().toISOString().slice(11, 19);
      const line = `[${stamp}] ${msg}`;
      lines.push(line);
      console.log(line);
      await flushDebug(workflowRunId, lines);
    }
  };
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
export async function runStepLogic(step, previousOutput) {
  switch (step.type) {
    case 'llm_call': {
      const prompt = (step.config?.prompt || '{{input}}').replace(
        '{{input}}',
        JSON.stringify(previousOutput ?? {})
      );

      let text;
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
        text = json.choices?.[0]?.message?.content ?? '';
      } else {
        await new Promise((r) => setTimeout(r, 1000));
        text = 'negative — the customer reports the product stopped working after two days';
      }

      const lower = text.toLowerCase();
      const sentiment = lower.includes('negative') ? 'negative' : lower.includes('positive') ? 'positive' : 'neutral';

      return { output: { text, sentiment }, callMade: true };
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
const STEP_PACING_MS = Number(process.env.STEP_PACING_MS ?? 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function executeStepsFrom({ steps, startIndex, workflowRunId, org, previousOutput }) {
  const { log } = makeLogger(workflowRunId);

  await log(`=== executeStepsFrom START — run=${workflowRunId} startIndex=${startIndex} totalSteps=${steps.length} ===`);
  await log(`Step order: ${steps.map(s => `${s.step_order}:${s.type}`).join(' -> ')}`);

  let callsMade = 0;
  let isPaused = false;
  let isFailed = false;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    await log(`---- LOOP i=${i} step_order=${step.step_order} type=${step.type} ----`);

    const stepRunId = await createStepRun(workflowRunId, step, previousOutput);
    await log(`created step_run id=${stepRunId}`);

    if (STEP_PACING_MS > 0) await sleep(STEP_PACING_MS);

    if (step.type === 'approval_gate') {
      await log(`step is approval_gate → pausing run and breaking loop`);
      await pauseRunAt(workflowRunId, step.step_order);
      await finishStepRun(stepRunId, { status: 'paused', output: null, error: null, attemptCount: 0 });
      isPaused = true;
      await log(`pauseRunAt done. isPaused=true`);
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
        await log(`attempt ${attempt}/${maxAttempts} SUCCEEDED, output=${JSON.stringify(output)}`);
        break;
      } catch (e) {
        lastError = e.message;
        await log(`attempt ${attempt}/${maxAttempts} FAILED: ${e.message}`);
      }
    }

    if (lastError) {
      await log(`step_order=${step.step_order} exhausted retries → marking run FAILED`);
      await finishStepRun(stepRunId, { status: 'failed', output: null, error: lastError, attemptCount: attempt });
      await failRun(workflowRunId);
      isFailed = true;
      break;
    }

    await finishStepRun(stepRunId, { status: 'completed', output, error: null, attemptCount: attempt });
    if (callMade) callsMade++;
    previousOutput = output;
    await log(`step_order=${step.step_order} marked completed. previousOutput=${JSON.stringify(previousOutput)}`);

    if (step.type === 'conditional_branch' && output?.result === false) {
      await log(`★★★ CONDITIONAL BRANCH FALSE at step_order=${step.step_order} — pausing run for decision ★★★`);
      await pauseRunAt(workflowRunId, step.step_order);
      isPaused = true;
      await log(`pauseRunAt done. isPaused=true — breaking loop`);
      break;
    } else if (step.type === 'conditional_branch') {
      await log(`conditional_branch result=${output?.result} (not false) — continuing normally`);
    }
  }

  await log(`LOOP ENDED. isPaused=${isPaused} isFailed=${isFailed}`);

  if (!isPaused && !isFailed) {
    await log(`neither paused nor failed → calling completeRun`);
    await completeRun(workflowRunId, org.id, callsMade);
  } else {
    await log(`SKIPPING completeRun (isPaused=${isPaused} isFailed=${isFailed})`);
  }

  const finalStatus = isPaused ? 'paused' : isFailed ? 'failed' : 'completed';
  await log(`=== executeStepsFrom END — returning status="${finalStatus}" ===`);

  return {
    status: finalStatus
  };
}