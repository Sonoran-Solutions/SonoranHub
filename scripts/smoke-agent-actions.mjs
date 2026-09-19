/* global console, process, setTimeout */

const apiBase = (process.env.SONORAN_SMOKE_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const machineId = process.env.SONORAN_SMOKE_MACHINE_ID;

async function getMachines() {
  const response = await globalThis.fetch(`${apiBase}/machines`);
  if (!response.ok) throw new Error(`machines request failed with ${response.status}`);
  return response.json();
}

const machines = await getMachines();
const machine = machineId
  ? machines.machines.find((candidate) => candidate.identity.id === machineId)
  : machines.machines.find((candidate) => candidate.status === 'ONLINE');
if (!machine)
  throw new Error('No online smoke machine found; set SONORAN_SMOKE_MACHINE_ID if needed');

const repository = machine.actionCatalog.repositories[0];
if (!repository) throw new Error('Online smoke machine does not advertise a repository target');

async function postAction(action) {
  const response = await globalThis.fetch(
    `${apiBase}/machines/${encodeURIComponent(machine.identity.id)}/actions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    },
  );
  return { response, body: await response.json() };
}

async function waitForTerminal(actionId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await globalThis.fetch(`${apiBase}/actions/${encodeURIComponent(actionId)}`);
    if (!response.ok) throw new Error(`action status failed with ${response.status}`);
    const action = await response.json();
    if (['SUCCEEDED', 'DENIED', 'FAILED', 'TIMED_OUT', 'INTERRUPTED'].includes(action.status))
      return action;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('action did not reach a terminal state');
}

const success = await postAction({ kind: 'repo.status', targetId: repository.id });
if (!success.response.ok) {
  throw new Error(
    `action request failed with ${success.response.status}: ${success.body.error?.code ?? 'unknown'}`,
  );
}
const result = await waitForTerminal(success.body.actionId);
if (result.status !== 'SUCCEEDED' || result.result?.kind !== 'repo.status') {
  throw new Error(`repo.status smoke failed: ${result.status}`);
}

const denied = await postAction({ kind: 'repo.status', targetId: 'definitely-not-allowed' });
if (denied.response.status !== 404 || denied.body.error?.code !== 'target_not_found') {
  throw new Error(
    `unknown target smoke expected 404/target_not_found: ${denied.response.status}/${denied.body.error?.code}`,
  );
}

console.log(
  JSON.stringify({
    machineId: machine.identity.id,
    repoStatus: { actionId: result.actionId, status: result.status, result: result.result },
    unknownTarget: {
      status: 'REJECTED',
      reason: denied.body.error.code,
      stage: 'hub_advertised_catalog',
    },
    serviceRestart: 'skipped unless a safe user-level test service is explicitly configured',
  }),
);
