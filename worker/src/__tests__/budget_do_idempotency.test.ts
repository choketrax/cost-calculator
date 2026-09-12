import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetDO } from '../budget_do';

async function callDO(
  stub: DurableObjectStub,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const res = await stub.fetch(`http://do${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

describe('BudgetDO — happy path', () => {
  it('reserve then settle records actual cost', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope';
    const period = '2023-10';

    // Configure budget $100
    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 100 });

    // Reserve $5
    const resReserve = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id: 'req1' });
    expect(resReserve.data.ok).toBe(true);
    expect(resReserve.data.available_after).toBe(95);
    const reservation_id = resReserve.data.reservation_id;

    // Settle $4.20
    const resSettle = await callDO(stub, 'POST', '/settle', { reservation_id, scope_id, period, actual_usd: 4.2 });
    expect(resSettle.data.ok).toBe(true);
    expect(resSettle.data.released_excess).toBeCloseTo(0.8);

    // Check status
    const resStatus = await callDO(stub, 'GET', `/status?scope_id=${scope_id}&period=${period}`);
    expect(resStatus.data.reserved_usd).toBe(0);
    expect(resStatus.data.settled_usd).toBeCloseTo(4.2);
    expect(resStatus.data.available_usd).toBeCloseTo(95.8);
  });

  it('reserve then release restores full budget', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-2';
    const period = '2023-10';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 100 });

    const resReserve = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id: 'req2' });
    const reservation_id = resReserve.data.reservation_id;

    const resRelease = await callDO(stub, 'POST', '/release', { reservation_id, scope_id, period });
    expect(resRelease.data.ok).toBe(true);

    const resStatus = await callDO(stub, 'GET', `/status?scope_id=${scope_id}&period=${period}`);
    expect(resStatus.data.reserved_usd).toBe(0);
    expect(resStatus.data.available_usd).toBe(100);
  });
});

describe('BudgetDO — idempotency', () => {
  it('second reserve with same request_id returns same reservation_id', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-idem';
    const period = '2023-10';
    const request_id = 'req-idem-1';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 100 });

    const res1 = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id });
    const res2 = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id });

    expect(res1.data.ok).toBe(true);
    expect(res2.data.ok).toBe(true);
    expect(res2.data.idempotent).toBe(true);
    expect(res1.data.reservation_id).toBe(res2.data.reservation_id);

    const resStatus = await callDO(stub, 'GET', `/status?scope_id=${scope_id}&period=${period}`);
    expect(resStatus.data.reserved_usd).toBe(5); // Not 10
  });

  it('double settle returns idempotent true on second call', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-idem-2';
    const period = '2023-10';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 100 });
    const resReserve = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id: 'req-idem-2' });
    const reservation_id = resReserve.data.reservation_id;

    const res1 = await callDO(stub, 'POST', '/settle', { reservation_id, scope_id, period, actual_usd: 3 });
    const res2 = await callDO(stub, 'POST', '/settle', { reservation_id, scope_id, period, actual_usd: 3 });

    expect(res1.data.ok).toBe(true);
    expect(res2.data.ok).toBe(true);
    expect(res2.data.idempotent).toBe(true);

    const resStatus = await callDO(stub, 'GET', `/status?scope_id=${scope_id}&period=${period}`);
    expect(resStatus.data.settled_usd).toBe(3); // Not 6
  });

  it('settle after release returns conflict', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-idem-3';
    const period = '2023-10';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 100 });
    const resReserve = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id: 'req-idem-3' });
    const reservation_id = resReserve.data.reservation_id;

    await callDO(stub, 'POST', '/release', { reservation_id, scope_id, period });
    
    const resSettle = await callDO(stub, 'POST', '/settle', { reservation_id, scope_id, period, actual_usd: 3 });
    expect(resSettle.status).toBe(409);
    expect(resSettle.data.reason).toBe('already_released');
  });

  it('double release is safe', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-idem-4';
    const period = '2023-10';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 100 });
    const resReserve = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id: 'req-idem-4' });
    const reservation_id = resReserve.data.reservation_id;

    const res1 = await callDO(stub, 'POST', '/release', { reservation_id, scope_id, period });
    const res2 = await callDO(stub, 'POST', '/release', { reservation_id, scope_id, period });

    expect(res1.data.ok).toBe(true);
    expect(res2.data.ok).toBe(true);
    expect(res2.data.idempotent).toBe(true);
    
    const resStatus = await callDO(stub, 'GET', `/status?scope_id=${scope_id}&period=${period}`);
    expect(resStatus.data.reserved_usd).toBe(0);
  });
});

describe('BudgetDO — budget enforcement', () => {
  it('rejects reservation when budget would be exceeded', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-budget-1';
    const period = '2023-10';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 10 });
    const res1 = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 6, request_id: 'req-b-1' });
    expect(res1.data.ok).toBe(true);

    const res2 = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id: 'req-b-2' });
    expect(res2.data.ok).toBe(false);
    expect(res2.data.reason).toBe('budget_exceeded');
  });

  it('budget is unlimited when budget_usd=0 (no config)', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-budget-2';
    const period = '2023-10';

    const res = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 1000, request_id: 'req-b-3' });
    expect(res.data.ok).toBe(true);
  });
});

describe('BudgetDO — concurrent reservations stay within budget', () => {
  it('100 concurrent reserves with $10 budget and $0.20 per request allows exactly 50', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-concurrent';
    const period = '2023-10';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 10 });

    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 0.20, request_id: `req-conc-${i}` }));
    }
    
    const results = await Promise.all(promises);
    
    const successes = results.filter(r => r.data.ok);
    const failures = results.filter(r => !r.data.ok);
    
    expect(successes.length).toBe(50);
    expect(failures.length).toBe(50);
    
    const resStatus = await callDO(stub, 'GET', `/status?scope_id=${scope_id}&period=${period}`);
    expect(resStatus.data.reserved_usd).toBeCloseTo(10, 2);
  });
});

describe('BudgetDO — alarm auto-release', () => {
  it('alarm releases stale active reservations', async () => {
    const id = env.BUDGET_DO.newUniqueId();
    const stub = env.BUDGET_DO.get(id);
    const scope_id = 'test-scope-alarm';
    const period = '2023-10';

    await callDO(stub, 'POST', '/configure', { scope_id, period, budget_usd: 100 });
    
    const resReserve = await callDO(stub, 'POST', '/reserve', { scope_id, period, amount_usd: 5, request_id: 'req-alarm-1' });
    expect(resReserve.data.ok).toBe(true);
    
    // Call alarm directly via runInDurableObject
    await runInDurableObject(stub, async (instance: BudgetDO, state) => {
      // Modify expires_at manually for test purpose or pass fake now
      instance.ctx.storage.sql.exec(`UPDATE reservations SET expires_at = ?`, new Date(Date.now() - 1000).toISOString());
      await instance.alarm();
    });

    const resStatus = await callDO(stub, 'GET', `/status?scope_id=${scope_id}&period=${period}`);
    expect(resStatus.data.reserved_usd).toBe(0);
  });
});
