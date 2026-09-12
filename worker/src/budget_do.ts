import { DurableObject } from 'cloudflare:workers';
import { deterministicId } from './idempotency';

export interface Env {
  // Define bindings here if necessary
}

export class BudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Initialize SQLite schema
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS budget_config (
        scope_id TEXT NOT NULL,
        budget_usd REAL NOT NULL,
        period TEXT NOT NULL,          -- 'YYYY-MM' or 'YYYY-MM-DD'
        warning_pct REAL DEFAULT 75.0,
        block_pct REAL DEFAULT 100.0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_id, period)
      );

      CREATE TABLE IF NOT EXISTS reservations (
        reservation_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        period TEXT NOT NULL,
        reserved_usd REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'settled' | 'released'
        request_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,              -- for alarm-based auto-release
        settled_actual_usd REAL,
        settled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS period_totals (
        scope_id TEXT NOT NULL,
        period TEXT NOT NULL,
        total_settled_usd REAL NOT NULL DEFAULT 0.0,
        total_reserved_usd REAL NOT NULL DEFAULT 0.0,
        total_requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, period)
      );
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === 'POST') {
        if (url.pathname === '/reserve') {
          return await this.handleReserve(req);
        } else if (url.pathname === '/settle') {
          return await this.handleSettle(req);
        } else if (url.pathname === '/release') {
          return await this.handleRelease(req);
        } else if (url.pathname === '/configure') {
          return await this.handleConfigure(req);
        }
      } else if (req.method === 'GET' && url.pathname === '/status') {
        return await this.handleStatus(url);
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (err: any) {
      return Response.json({ error: err.message || 'Internal error' }, { status: 500 });
    }
  }

  private async handleReserve(req: Request): Promise<Response> {
    const body: any = await req.json();
    const { scope_id, period, amount_usd, request_id } = body;
    
    // 1. Get current budget_usd
    const config = this.ctx.storage.sql.exec(
      `SELECT budget_usd FROM budget_config WHERE scope_id = ? AND period = ?`, 
      scope_id, period
    ).toArray();
    
    const budget_usd = config.length > 0 ? (config[0] as any).budget_usd : 0; // 0 = unlimited

    // 2. Initialize and get period totals
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO period_totals (scope_id, period) VALUES (?, ?)`, 
      scope_id, period
    );
    
    const totals = this.ctx.storage.sql.exec(
      `SELECT total_reserved_usd, total_settled_usd FROM period_totals WHERE scope_id = ? AND period = ?`, 
      scope_id, period
    ).toArray()[0] as any;

    // 3. Calculate availability
    const total_reserved = totals.total_reserved_usd;
    const total_settled = totals.total_settled_usd;
    let available = Infinity;
    
    if (budget_usd > 0) {
      available = budget_usd - total_reserved - total_settled;
    }

    // 4. Check if available - amount_usd < 0
    if (budget_usd > 0 && available - amount_usd < 0) {
      return Response.json({
        ok: false,
        reason: 'budget_exceeded',
        available_before: available,
        available_after: available,
        budget_usd
      });
    }

    // 5. Insert into reservations
    if (!request_id) {
      return Response.json({ ok: false, reason: 'request_id_required' }, { status: 400 });
    }

    const reservation_id = await deterministicId(request_id, 'reserve');
    const now = new Date();
    const created_at = now.toISOString();
    
    // Auto-release after 30 seconds
    const expires_at_date = new Date(now.getTime() + 30000);
    const expires_at = expires_at_date.toISOString();

    // INSERT OR IGNORE — if same request_id retries, the existing row survives
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO reservations (
        reservation_id, scope_id, period, reserved_usd, request_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, reservation_id, scope_id, period, amount_usd, request_id, created_at, expires_at);

    // Read back the authoritative row (may be existing if this is a retry)
    const existing = this.ctx.storage.sql.exec(
      `SELECT reservation_id, reserved_usd, status FROM reservations WHERE reservation_id = ?`,
      reservation_id
    ).toArray()[0] as any;

    // If the row already existed AND is not 'active', return without updating totals
    if (existing.status !== 'active') {
      return Response.json({
        ok: true,
        idempotent: true,
        reservation_id: existing.reservation_id,
        reason: `already_\${existing.status}`,
        available_before: available,
        available_after: available,
        budget_usd,
      });
    }

    // Check if the INSERT was a no-op (row existed, we skipped the period_totals update)
    const justInserted = this.ctx.storage.sql.exec(
      `SELECT 1 FROM reservations WHERE reservation_id = ? AND created_at = ?`,
      reservation_id, created_at
    ).toArray().length > 0;

    if (!justInserted) {
      // This was a retry — reservation already exists, period_totals already updated
      return Response.json({
        ok: true,
        idempotent: true,
        reservation_id,
        available_before: available,
        available_after: budget_usd > 0 ? available - amount_usd : Infinity,
        budget_usd,
      });
    }

    // 6. Update period_totals
    this.ctx.storage.sql.exec(`
      UPDATE period_totals
      SET total_reserved_usd = total_reserved_usd + ?
      WHERE scope_id = ? AND period = ?
    `, amount_usd, scope_id, period);

    // 7. Schedule alarm
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || expires_at_date.getTime() < currentAlarm) {
      await this.ctx.storage.setAlarm(expires_at_date.getTime());
    }

    return Response.json({
      ok: true,
      reservation_id,
      available_before: available,
      available_after: budget_usd > 0 ? available - amount_usd : Infinity,
      budget_usd
    });
  }

  private async handleSettle(req: Request): Promise<Response> {
    const body: any = await req.json();
    const { reservation_id, actual_usd, scope_id, period } = body;

    const res = this.ctx.storage.sql.exec(
      `SELECT reserved_usd, status, settled_actual_usd FROM reservations WHERE reservation_id = ?`, 
      reservation_id
    ).toArray();
    
    const reservation = res.length > 0 ? res[0] as any : null;

    if (!reservation) {
      return Response.json({ ok: false, reason: 'reservation_not_found' }, { status: 404 });
    }

    // Idempotency guard: if already settled or released, return without double-counting
    if (reservation.status === 'settled') {
      return Response.json({
        ok: true,
        idempotent: true,
        reason: 'already_settled',
        settled_actual_usd: reservation.settled_actual_usd,
      });
    }
    if (reservation.status === 'released') {
      return Response.json({
        ok: false,
        reason: 'already_released',
        message: 'Cannot settle a released reservation. Cost will not be recorded.',
      }, { status: 409 });
    }

    if (reservation.status !== 'active') {
      return Response.json({ ok: false, error: 'Invalid or non-active reservation' });
    }

    const reserved_usd = (res[0] as any).reserved_usd;
    const excess = reserved_usd - actual_usd;
    const settled_at = new Date().toISOString();

    // 3. Update reservation
    this.ctx.storage.sql.exec(`
      UPDATE reservations 
      SET status = 'settled', settled_actual_usd = ?, settled_at = ?
      WHERE reservation_id = ?
    `, actual_usd, settled_at, reservation_id);

    // 4. Update period_totals
    this.ctx.storage.sql.exec(`
      UPDATE period_totals
      SET total_reserved_usd = total_reserved_usd - ?,
          total_settled_usd = total_settled_usd + ?,
          total_requests = total_requests + 1
      WHERE scope_id = ? AND period = ?
    `, reserved_usd, actual_usd, scope_id, period);

    return Response.json({ ok: true, released_excess: excess });
  }

  private async handleRelease(req: Request): Promise<Response> {
    const body: any = await req.json();
    const { reservation_id, scope_id, period } = body;

    const res = this.ctx.storage.sql.exec(
      `SELECT reserved_usd, status FROM reservations WHERE reservation_id = ?`, 
      reservation_id
    ).toArray();
    
    const reservation = res.length > 0 ? res[0] as any : null;

    if (!reservation) {
      return Response.json({ ok: false, reason: 'reservation_not_found' }, { status: 404 });
    }

    // Idempotency guard: double-release is safe, return ok
    if (reservation.status === 'released') {
      return Response.json({ ok: true, idempotent: true, reason: 'already_released' });
    }
    if (reservation.status === 'settled') {
      return Response.json({
        ok: false,
        reason: 'already_settled',
        message: 'Cannot release a settled reservation.',
      }, { status: 409 });
    }

    if (reservation.status !== 'active') {
      return Response.json({ ok: false, error: 'Invalid or non-active reservation' });
    }

    const reserved_usd = (res[0] as any).reserved_usd;

    // 2. Update reservation
    this.ctx.storage.sql.exec(`
      UPDATE reservations
      SET status = 'released'
      WHERE reservation_id = ?
    `, reservation_id);

    // 3. Update period_totals
    this.ctx.storage.sql.exec(`
      UPDATE period_totals
      SET total_reserved_usd = total_reserved_usd - ?
      WHERE scope_id = ? AND period = ?
    `, reserved_usd, scope_id, period);

    return Response.json({ ok: true });
  }

  private async handleConfigure(req: Request): Promise<Response> {
    const body: any = await req.json();
    const { scope_id, period, budget_usd, warning_pct, block_pct } = body;
    const updated_at = new Date().toISOString();

    this.ctx.storage.sql.exec(`
      INSERT INTO budget_config (scope_id, period, budget_usd, warning_pct, block_pct, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, period) DO UPDATE SET
        budget_usd = excluded.budget_usd,
        warning_pct = excluded.warning_pct,
        block_pct = excluded.block_pct,
        updated_at = excluded.updated_at
    `, scope_id, period, budget_usd, warning_pct ?? 75.0, block_pct ?? 100.0, updated_at);

    return Response.json({ ok: true });
  }

  private async handleStatus(url: URL): Promise<Response> {
    const scope_id = url.searchParams.get('scope_id');
    const period = url.searchParams.get('period');

    if (!scope_id || !period) {
      return Response.json({ error: 'Missing scope_id or period' }, { status: 400 });
    }

    const config = this.ctx.storage.sql.exec(
      `SELECT * FROM budget_config WHERE scope_id = ? AND period = ?`, 
      scope_id, period
    ).toArray();
    
    const budget_usd = config.length > 0 ? (config[0] as any).budget_usd : 0;
    const warning_pct = config.length > 0 ? (config[0] as any).warning_pct : 75.0;
    const block_pct = config.length > 0 ? (config[0] as any).block_pct : 100.0;

    const totalsRes = this.ctx.storage.sql.exec(
      `SELECT total_reserved_usd, total_settled_usd FROM period_totals WHERE scope_id = ? AND period = ?`, 
      scope_id, period
    ).toArray();
    
    const reserved_usd = totalsRes.length > 0 ? (totalsRes[0] as any).total_reserved_usd : 0;
    const settled_usd = totalsRes.length > 0 ? (totalsRes[0] as any).total_settled_usd : 0;

    let available_usd = Infinity;
    let consumption_pct = 0;
    let status = 'ok';

    if (budget_usd > 0) {
      available_usd = budget_usd - reserved_usd - settled_usd;
      consumption_pct = ((reserved_usd + settled_usd) / budget_usd) * 100;

      if (available_usd < 0 || consumption_pct >= block_pct) {
        status = 'exceeded';
      } else if (consumption_pct >= warning_pct) {
        status = 'warning';
      }
    }

    return Response.json({
      scope_id,
      period,
      budget_usd,
      reserved_usd,
      settled_usd,
      available_usd,
      consumption_pct,
      status,
      warning_pct,
      block_pct
    });
  }

  async alarm(): Promise<void> {
    const now = new Date().toISOString();
    
    // Find all active reservations that have expired
    const expired = this.ctx.storage.sql.exec(`
      SELECT reservation_id, scope_id, period, reserved_usd
      FROM reservations
      WHERE status = 'active' AND expires_at <= ?
    `, now).toArray();

    let count = 0;
    for (const res of expired) {
      const row = res as any;
      
      // Release reservation
      this.ctx.storage.sql.exec(`
        UPDATE reservations
        SET status = 'released'
        WHERE reservation_id = ?
      `, row.reservation_id);

      // Decrement totals
      this.ctx.storage.sql.exec(`
        UPDATE period_totals
        SET total_reserved_usd = total_reserved_usd - ?
        WHERE scope_id = ? AND period = ?
      `, row.reserved_usd, row.scope_id, row.period);
      
      count++;
    }

    if (count > 0) {
      console.log(`Auto-released ${count} stale reservations.`);
    }

    // Check if there are more upcoming expirations
    const upcoming = this.ctx.storage.sql.exec(`
      SELECT expires_at
      FROM reservations
      WHERE status = 'active'
      ORDER BY expires_at ASC
      LIMIT 1
    `).toArray();

    if (upcoming.length > 0) {
      const nextExp = new Date((upcoming[0] as any).expires_at).getTime();
      await this.ctx.storage.setAlarm(nextExp);
    }
  }
}

// Utility to get current period if needed
export function currentPeriod(date = new Date()): string {
  return `\${date.getUTCFullYear()}-\${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
