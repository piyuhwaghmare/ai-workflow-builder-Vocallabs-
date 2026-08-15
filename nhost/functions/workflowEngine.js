// workflowEngine.js  (DEBUG BUILD — heavily logged for tracing)
// Shared logic used by BOTH Action handlers: executeWorkflowRun.js and approveStep.js
// Keeping this in one place means "resume after approval" behaves identically to
// "run from the start" — same retry rules, same step_runs bookkeeping, same quota logic.
//
// EVERY function below logs on entry, on key internal decisions, and on exit
// (success or failure). Look for the "[tag]" prefix in your server logs to
// trace exactly how far execution got before something went wrong.
// Once you've found the problem, swap this file back for the clean version —
// this one is deliberately noisy and not meant to stay in production.

const GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL;
const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET;

console.log('[BOOT] workflowEngine.js loaded. GRAPHQL_URL set?', !!GRAPHQL_URL, '| ADMIN_SECRET set?', !!ADMIN_SECRET);

if (!GRAPHQL_URL || !ADMIN_SECRET) {
  console.error('[BOOT] FATAL: missing NHOST_GRAPHQL_URL or NHOST_ADMIN_SECRET');
  throw new Error('Missing required environment variables: NHOST_GRAPHQL_URL or NHOST_ADMIN_SECRET');
}

// ---------- GraphQL helper ----------
export async function gql(query, variables) {
  const opName = (query.match(/(?:mutation|query)\s+(\w+)/) || [])[1] || 'anonymous';
  console.log(`[gql] → sending "${opName}" with variables:`, JSON.stringify(variables));
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
    console.error(`[gql] ✕ "${opName}" FAILED:`, JSON.stringify(data.errors));
    throw new Error(data.errors[0].message);
  }
  console.log(`[gql] ✓ "${opName}" succeeded:`, JSON.stringify(data.data));
  return data.data;
}

// ---------- step_runs helpers ----------
export async function createStepRun(workflowRunId, step, input) {
  console.log(`[createStepRun] → run=${workflowRunId} step_order=${step.step_order} type=${step.type}`);
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
  const id = data.insert_step_runs_one.id;
  console.log(`[createStepRun] ✓ created step_run id=${id}`);
  return id;
}

export async function finishStepRun(stepRunId, { status, output, error, attemptCount }) {
  console.log(`[finishStepRun] → id=${stepRunId} status=${status} attemptCount=${attemptCount} error=${error ?? 'none'}`);
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
  console.log(`[finishStepRun] ✓ done for id=${stepRunId}`);
}

export async function pauseRunAt(workflowRunId, stepOrder) {
  console.log(`[pauseRunAt] → PAUSING run=${workflowRunId} at step_order=${stepOrder}`);
  const mutation = `
    mutation PauseRun($run_id: uuid!, $step_order: Int!) {
      update_workflow_runs_by_pk(
        pk_columns: { id: $run_id }
        _set: { status: "paused", current_step_order: $step_order }
      ) { id }
    }
  `;
  await gql(mutation, { run_id: workflowRunId, step_order: stepOrder });
  console.log(`[pauseRunAt] ✓ run=${workflowRunId} is now PAUSED in the database`);
}

export async function resumeRun(workflowRunId) {
  console.log(`[resumeRun] → RESUMING run=${workflowRunId}`);
  const mutation = `
    mutation ResumeRun($run_id: uuid!) {
      update_workflow_runs_by_pk(
        pk_columns: { id: $run_id }
        _set: { status: "running" }
      ) { id }
    }
  `;
  await gql(mutation, { run_id: workflowRunId });
  console.log(`[resumeRun] ✓ run=${workflowRunId} is now RUNNING in the database`);
}

export async function completeRun(workflowRunId, orgId, callsMade) {
  console.log(`[completeRun] → COMPLETING run=${workflowRunId} org=${orgId} callsMade=${callsMade}`);
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
  console.log(`[completeRun] ✓ run=${workflowRunId} is now COMPLETED in the database`);
}

export async function failRun(workflowRunId) {
  console.log(`[failRun] → FAILING run=${workflowRunId}`);
  const mutation = `
    mutation FailRun($run_id: uuid!) {
      update_workflow_runs_by_pk(
        pk_columns: { id: $run_id }
        _set: { status: "failed", finished_at: "now()" }
      ) { id }
    }
  `;
  await gql(mutation, { run_id: workflowRunId });
  console.log(`[failRun] ✓ run=${workflowRunId} is now FAILED in the database`);
}

// ---------- per-step-type execution ----------
// Returns { output, callMade } — callMade=true counts against org quota (llm_call / http_request only)
export async function runStepLogic(step, previousOutput) {
  console.log(`[runStepLogic] → type=${step.type} step_order=${step.step_order} previousOutput=${JSON.stringify(previousOutput)}`);
  switch (step.type) {
    case 'llm_call': {
      const prompt = (step.config?.prompt || '{{input}}').replace(
        '{{input}}',
        JSON.stringify(previousOutput ?? {})
      );
      console.log(`[runStepLogic:llm_call] prompt built:`, prompt);

      let text;
      if (process.env.GROQ_API_KEY) {
        console.log('[runStepLogic:llm_call] GROQ_API_KEY present — calling real API');
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
        console.log('[runStepLogic:llm_call] Groq HTTP status:', resp.status);
        if (!resp.ok) throw new Error(`LLM API error: ${resp.status}`);
        const json = await resp.json();
        text = json.choices?.[0]?.message?.content ?? '';
      } else {
        console.log('[runStepLogic:llm_call] no GROQ_API_KEY — using stubbed fallback');
        await new Promise((r) => setTimeout(r, 1000));
        text = 'negative — the customer reports the product stopped working after two days';
      }

      const lower = text.toLowerCase();
      const sentiment = lower.includes('negative') ? 'negative' : lower.includes('positive') ? 'positive' : 'neutral';
      console.log(`[runStepLogic:llm_call] ✓ derived sentiment="${sentiment}" from text="${text.slice(0, 80)}..."`);

      return { output: { text, sentiment }, callMade: true };
    }

    case 'http_request': {
      const { url, method = 'GET', headers = {}, body } = step.config || {};
      console.log(`[runStepLogic:http_request] → ${method} ${url}`);
      if (!url) throw new Error('http_request step missing config.url');
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
      console.log('[runStepLogic:http_request] status:', resp.status);
      if (!resp.ok) throw new Error(`HTTP request failed: ${resp.status}`);
      const json = await resp.json().catch(() => ({}));
      console.log('[runStepLogic:http_request] ✓ response body:', JSON.stringify(json));
      return { output: json, callMade: true };
    }

    case 'db_write': {
      console.log('[runStepLogic:db_write] ✓ recording previousOutput as saved data');
      return { output: { saved: true, data: previousOutput ?? null }, callMade: false };
    }

    case 'notify': {
      console.log('[runStepLogic:notify] ✓ stub — recording intent only, channel=', step.config?.slack_channel ?? null);
      return { output: { notified: true, channel: step.config?.slack_channel ?? null }, callMade: false };
    }

    case 'conditional_branch': {
      const condition = step.config?.condition;
      const result = evaluateCondition(condition, previousOutput);
      console.log(`[runStepLogic:conditional_branch] condition="${condition}" evaluated against previousOutput=${JSON.stringify(previousOutput)} → result=${result}`);
      return { output: { condition, result }, callMade: false };
    }

    default:
      console.error(`[runStepLogic] ✕ UNKNOWN step type: ${step.type}`);
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function evaluateCondition(condition, previousOutput) {
  console.log(`[evaluateCondition] condition="${condition}" previousOutput=${JSON.stringify(previousOutput)}`);
  if (!condition) {
    console.log('[evaluateCondition] no condition set → defaulting to true');
    return true;
  }
  const eqMatch = condition.split('==').map((s) => s.trim());
  if (eqMatch.length === 2) {
    const [field, expected] = eqMatch;
    const actual = previousOutput?.[field];
    const result = String(actual) === expected;
    console.log(`[evaluateCondition] EQ check: field="${field}" actual="${actual}" expected="${expected}" → ${result}`);
    return result;
  }
  const neqMatch = condition.split('!=').map((s) => s.trim());
  if (neqMatch.length === 2) {
    const [field, expected] = neqMatch;
    const actual = previousOutput?.[field];
    const result = String(actual) !== expected;
    console.log(`[evaluateCondition] NEQ check: field="${field}" actual="${actual}" expected="${expected}" → ${result}`);
    return result;
  }
  console.log('[evaluateCondition] no == or != found in condition → defaulting to true');
  return true;
}

// ---------- the shared execution loop ----------
// Runs steps starting at startIndex (0-based) in `steps`. Used both for a fresh run
// (startIndex = 0) and for resuming after an approval_gate (startIndex = gate + 1).
const STEP_PACING_MS = Number(process.env.STEP_PACING_MS ?? 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function executeStepsFrom({ steps, startIndex, workflowRunId, org, previousOutput }) {
  console.log(`\n========== [executeStepsFrom] START ==========`);
  console.log(`[executeStepsFrom] run=${workflowRunId} startIndex=${startIndex} totalSteps=${steps.length} org=${org?.id}`);
  console.log(`[executeStepsFrom] step order in this run:`, steps.map(s => `${s.step_order}:${s.type}`).join(' -> '));

  let callsMade = 0;
  let isPaused = false;
  let isFailed = false;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    console.log(`\n---- [executeStepsFrom] LOOP i=${i} step_order=${step.step_order} type=${step.type} ----`);

    const stepRunId = await createStepRun(workflowRunId, step, previousOutput);

    if (STEP_PACING_MS > 0) {
      console.log(`[executeStepsFrom] pacing delay ${STEP_PACING_MS}ms before executing step...`);
      await sleep(STEP_PACING_MS);
    }

    if (step.type === 'approval_gate') {
      console.log(`[executeStepsFrom] step is approval_gate → pausing and BREAKING loop`);
      await pauseRunAt(workflowRunId, step.step_order);
      await finishStepRun(stepRunId, { status: 'paused', output: null, error: null, attemptCount: 0 });
      isPaused = true;
      console.log(`[executeStepsFrom] isPaused=true, isFailed=false — breaking out of for-loop now`);
      break;
    }

    const maxAttempts = (step.type === 'llm_call' || step.type === 'http_request') ? 2 : 1;
    let attempt = 0;
    let output = null;
    let lastError = null;
    let callMade = false;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`[executeStepsFrom] attempt ${attempt}/${maxAttempts} for step_order=${step.step_order}`);
      try {
        const result = await runStepLogic(step, previousOutput);
        output = result.output;
        callMade = result.callMade;
        lastError = null;
        console.log(`[executeStepsFrom] attempt ${attempt} SUCCEEDED, output=${JSON.stringify(output)}`);
        break;
      } catch (e) {
        lastError = e.message;
        console.error(`[executeStepsFrom] attempt ${attempt} FAILED:`, e.message);
      }
    }

    if (lastError) {
      console.error(`[executeStepsFrom] step_order=${step.step_order} exhausted retries — marking FAILED and stopping run`);
      await finishStepRun(stepRunId, { status: 'failed', output: null, error: lastError, attemptCount: attempt });
      await failRun(workflowRunId);
      isFailed = true;
      console.log(`[executeStepsFrom] isFailed=true — breaking out of for-loop now`);
      break;
    }

    await finishStepRun(stepRunId, { status: 'completed', output, error: null, attemptCount: attempt });
    if (callMade) callsMade++;
    previousOutput = output;
    console.log(`[executeStepsFrom] step_order=${step.step_order} marked completed. callsMade so far=${callsMade}. previousOutput updated to:`, JSON.stringify(previousOutput));

    if (step.type === 'conditional_branch' && output?.result === false) {
      console.log(`[executeStepsFrom] ★★★ CONDITIONAL BRANCH FALSE DETECTED at step_order=${step.step_order} ★★★`);
      console.log(`[executeStepsFrom] about to call pauseRunAt(${workflowRunId}, ${step.step_order})`);
      await pauseRunAt(workflowRunId, step.step_order);
      console.log(`[executeStepsFrom] pauseRunAt returned successfully — setting isPaused=true and breaking loop`);
      isPaused = true;
      break;
    } else if (step.type === 'conditional_branch') {
      console.log(`[executeStepsFrom] conditional_branch result was NOT false (result=${output?.result}) — continuing loop normally, no pause`);
    }
  }

  console.log(`\n[executeStepsFrom] LOOP ENDED. isPaused=${isPaused} isFailed=${isFailed}`);

  if (!isPaused && !isFailed) {
    console.log(`[executeStepsFrom] neither paused nor failed → calling completeRun (this marks status="completed")`);
    await completeRun(workflowRunId, org.id, callsMade);
  } else {
    console.log(`[executeStepsFrom] SKIPPING completeRun because isPaused=${isPaused} isFailed=${isFailed}`);
  }

  const finalStatus = isPaused ? 'paused' : isFailed ? 'failed' : 'completed';
  console.log(`[executeStepsFrom] RETURNING status="${finalStatus}"`);
  console.log(`========== [executeStepsFrom] END ==========\n`);

  return {
    status: finalStatus
  };
}