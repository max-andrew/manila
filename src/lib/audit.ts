export type AuditEntry = {
  actor: 'agent' | 'employer' | 'system';
  action: string;
  run_id?: number | null;
  detail?: unknown;
  policy_result?: 'pass' | 'blocked' | null;
  tx_refs?: string[];
};

export async function audit(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_log (actor, action, run_id, detail, policy_result, tx_refs) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(
      e.actor,
      e.action,
      e.run_id ?? null,
      e.detail === undefined ? null : JSON.stringify(e.detail),
      e.policy_result ?? null,
      e.tx_refs ? JSON.stringify(e.tx_refs) : null
    )
    .run();
}
