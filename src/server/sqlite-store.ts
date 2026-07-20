/**
 * SQLite-backed {@link PaymentStore}, on Node's built-in `node:sqlite`.
 *
 * No native module, no build step, no external service: a merchant can run
 * hood-pay against a single file. The sibling `hood402` facilitator uses the
 * same approach for its settlement ledger, so an operator running both gets
 * one operational story.
 *
 * The two atomicity guarantees the contract demands are enforced by the
 * database rather than by application logic:
 *
 *  - `createIntent` relies on the PRIMARY KEY on `intents.id` (derived from the
 *    idempotency key) so a concurrent duplicate create raises a constraint
 *    violation instead of inserting twice.
 *  - `claimRelay` is a single conditional `UPDATE ... WHERE status IN (...)`.
 *    SQLite serializes writers, so exactly one concurrent caller sees
 *    `changes === 1` and owns the relay.
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

import { IdempotencyConflictError } from '../core/errors.js'
import type { HoodPayErrorCode } from '../core/errors.js'
import type { Address, Hex } from '../core/networks.js'
import type {
  AuthorizationWire,
  IntentStatus,
  PaymentIntent,
  PaymentReceipt,
  WebhookEvent,
} from '../core/types.js'
import type {
  ClaimResult,
  CreateResult,
  IntentPatch,
  ListIntentsOptions,
  PaymentStore,
  WebhookDelivery,
} from './store.js'

// `node:sqlite` is not in vite's static builtin list, so a bare `import`
// statement gets mis-resolved under vitest. `createRequire` is opaque to
// vite's import analysis and Node resolves core modules from ESM this way.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

interface IntentRow {
  id: string
  merchant_id: string
  status: string
  amount: string
  network: string
  chain_id: number
  asset: string
  pay_to: string
  description: string
  metadata: string
  created_at: number
  expires_at: number
  idempotency_key: string | null
  fingerprint: string
  success_url: string | null
  cancel_url: string | null
  payer: string | null
  authorization: string | null
  tx_hash: string | null
  block_number: string | null
  settled_at: number | null
  failure_code: string | null
  failure_message: string | null
}

function rowToIntent(row: IntentRow): PaymentIntent {
  return {
    object: 'payment_intent',
    id: row.id,
    merchantId: row.merchant_id,
    status: row.status as IntentStatus,
    amount: BigInt(row.amount),
    network: row.network,
    chainId: row.chain_id,
    asset: row.asset as Address,
    payTo: row.pay_to as Address,
    description: row.description,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.success_url !== null ? { successUrl: row.success_url } : {}),
    ...(row.cancel_url !== null ? { cancelUrl: row.cancel_url } : {}),
    ...(row.payer !== null ? { payer: row.payer as Address } : {}),
    ...(row.authorization !== null
      ? { authorization: JSON.parse(row.authorization) as AuthorizationWire }
      : {}),
    ...(row.tx_hash !== null ? { txHash: row.tx_hash as Hex } : {}),
    ...(row.block_number !== null ? { blockNumber: BigInt(row.block_number) } : {}),
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    ...(row.failure_code !== null ? { failureCode: row.failure_code as HoodPayErrorCode } : {}),
    ...(row.failure_message !== null ? { failureMessage: row.failure_message } : {}),
  }
}

/** Statuses from which a relay claim is allowed. */
const CLAIMABLE = ['requires_payment', 'failed'] as const

export class SqliteStore implements PaymentStore {
  private readonly db: DatabaseSyncType

  /**
   * @param path A file path, or `':memory:'` for an ephemeral database.
   */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        id              TEXT PRIMARY KEY,
        merchant_id     TEXT NOT NULL,
        status          TEXT NOT NULL,
        amount          TEXT NOT NULL,
        network         TEXT NOT NULL,
        chain_id        INTEGER NOT NULL,
        asset           TEXT NOT NULL,
        pay_to          TEXT NOT NULL,
        description     TEXT NOT NULL,
        metadata        TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        idempotency_key TEXT,
        fingerprint     TEXT NOT NULL,
        success_url     TEXT,
        cancel_url      TEXT,
        payer           TEXT,
        authorization   TEXT,
        tx_hash         TEXT,
        block_number    TEXT,
        settled_at      INTEGER,
        failure_code    TEXT,
        failure_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
      CREATE INDEX IF NOT EXISTS idx_intents_merchant ON intents(merchant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_intents_expiry ON intents(expires_at);

      CREATE TABLE IF NOT EXISTS receipts (
        intent_id     TEXT PRIMARY KEY,
        payload       TEXT NOT NULL,
        digest        TEXT NOT NULL,
        tx_hash       TEXT NOT NULL,
        settled_at    INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_tx ON receipts(tx_hash);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id          TEXT PRIMARY KEY,
        intent_id   TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        url         TEXT NOT NULL,
        status      INTEGER,
        attempts    INTEGER NOT NULL,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        delivered   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_intent ON webhook_deliveries(intent_id);
    `)
  }

  async createIntent(intent: PaymentIntent, fingerprint: string): Promise<CreateResult> {
    try {
      this.db
        .prepare(
          `INSERT INTO intents (
             id, merchant_id, status, amount, network, chain_id, asset, pay_to, description,
             metadata, created_at, expires_at, idempotency_key, fingerprint, success_url, cancel_url
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intent.id,
          intent.merchantId,
          intent.status,
          intent.amount.toString(),
          intent.network,
          intent.chainId,
          intent.asset,
          intent.payTo,
          intent.description,
          JSON.stringify(intent.metadata),
          intent.createdAt,
          intent.expiresAt,
          intent.idempotencyKey ?? null,
          fingerprint,
          intent.successUrl ?? null,
          intent.cancelUrl ?? null,
        )
      return { intent, created: true }
    } catch {
      // PRIMARY KEY violation: this id already exists (idempotent replay).
      const row = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(intent.id) as
        | IntentRow
        | undefined
      if (!row) throw new Error(`hood-pay: failed to insert intent "${intent.id}"`)
      if (row.fingerprint !== fingerprint && intent.idempotencyKey) {
        throw new IdempotencyConflictError(intent.idempotencyKey, row.id)
      }
      return { intent: rowToIntent(row), created: false }
    }
  }

  async getIntent(id: string): Promise<PaymentIntent | undefined> {
    const row = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as
      | IntentRow
      | undefined
    return row ? rowToIntent(row) : undefined
  }

  async updateIntent(id: string, patch: IntentPatch): Promise<PaymentIntent> {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    const push = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.payer !== undefined) push('payer', patch.payer)
    if (patch.authorization !== undefined) push('authorization', JSON.stringify(patch.authorization))
    if (patch.txHash !== undefined) push('tx_hash', patch.txHash)
    if (patch.blockNumber !== undefined) push('block_number', patch.blockNumber.toString())
    if (patch.settledAt !== undefined) push('settled_at', patch.settledAt)
    if (patch.failureCode !== undefined) push('failure_code', patch.failureCode)
    if (patch.failureMessage !== undefined) push('failure_message', patch.failureMessage)

    if (sets.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE intents SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }
    const updated = await this.getIntent(id)
    if (!updated) throw new Error(`hood-pay: cannot update unknown intent "${id}"`)
    return updated
  }

  async claimRelay(
    id: string,
    payer: Address,
    authorization: AuthorizationWire,
    now: number,
  ): Promise<ClaimResult> {
    const placeholders = CLAIMABLE.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE intents
            SET status = 'processing', payer = ?, authorization = ?
          WHERE id = ?
            AND status IN (${placeholders})
            AND expires_at > ?`,
      )
      .run(payer, JSON.stringify(authorization), id, ...CLAIMABLE, now)

    if (Number(result.changes) === 1) {
      const intent = await this.getIntent(id)
      if (!intent) throw new Error(`hood-pay: claimed intent "${id}" vanished`)
      return { claimed: true, intent }
    }

    const intent = await this.getIntent(id)
    if (!intent) return { claimed: false, reason: 'not_found' }
    if (intent.status === 'succeeded') return { claimed: false, reason: 'already_paid', intent }
    if (intent.status === 'processing') {
      return { claimed: false, reason: 'already_processing', intent }
    }
    if (now >= intent.expiresAt) {
      const expired = await this.updateIntent(id, { status: 'expired' })
      return { claimed: false, reason: 'expired', intent: expired }
    }
    return { claimed: false, reason: 'terminal', intent }
  }

  async expireDue(now: number): Promise<PaymentIntent[]> {
    const placeholders = CLAIMABLE.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT * FROM intents WHERE status IN (${placeholders}) AND expires_at <= ?`,
      )
      .all(...CLAIMABLE, now) as unknown as IntentRow[]
    if (rows.length === 0) return []
    this.db
      .prepare(
        `UPDATE intents SET status = 'expired' WHERE status IN (${placeholders}) AND expires_at <= ?`,
      )
      .run(...CLAIMABLE, now)
    return rows.map((row) => ({ ...rowToIntent(row), status: 'expired' as const }))
  }

  async listIntents(options: ListIntentsOptions = {}): Promise<PaymentIntent[]> {
    const where: string[] = []
    const values: Array<string | number> = []
    if (options.merchantId) {
      where.push('merchant_id = ?')
      values.push(options.merchantId)
    }
    if (options.status) {
      where.push('status = ?')
      values.push(options.status)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    values.push(options.limit ?? 100)
    const rows = this.db
      .prepare(`SELECT * FROM intents ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...values) as unknown as IntentRow[]
    return rows.map(rowToIntent)
  }

  async saveReceipt(receipt: PaymentReceipt): Promise<void> {
    const payload = JSON.stringify(receipt, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    )
    this.db
      .prepare(
        `INSERT INTO receipts (intent_id, payload, digest, tx_hash, settled_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(intent_id) DO UPDATE SET
           payload = excluded.payload, digest = excluded.digest,
           tx_hash = excluded.tx_hash, settled_at = excluded.settled_at`,
      )
      .run(receipt.intentId, payload, receipt.digest, receipt.txHash, receipt.settledAt)
  }

  async getReceipt(intentId: string): Promise<PaymentReceipt | undefined> {
    const row = this.db.prepare('SELECT payload FROM receipts WHERE intent_id = ?').get(intentId) as
      | { payload: string }
      | undefined
    if (!row) return undefined
    const parsed = JSON.parse(row.payload) as Record<string, unknown>
    return {
      ...(parsed as unknown as PaymentReceipt),
      amount: BigInt(parsed['amount'] as string),
      validAfter: BigInt(parsed['validAfter'] as string),
      validBefore: BigInt(parsed['validBefore'] as string),
      blockNumber: BigInt(parsed['blockNumber'] as string),
    }
  }

  async recordWebhookDelivery(delivery: WebhookDelivery): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, intent_id, event_type, url, status, attempts, error, created_at, updated_at, delivered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, attempts = excluded.attempts, error = excluded.error,
           updated_at = excluded.updated_at, delivered = excluded.delivered`,
      )
      .run(
        delivery.id,
        delivery.intentId,
        delivery.eventType,
        delivery.url,
        delivery.status,
        delivery.attempts,
        delivery.error,
        delivery.createdAt,
        delivery.updatedAt,
        delivery.delivered ? 1 : 0,
      )
  }

  async listWebhookDeliveries(intentId: string): Promise<WebhookDelivery[]> {
    const rows = this.db
      .prepare('SELECT * FROM webhook_deliveries WHERE intent_id = ? ORDER BY created_at ASC')
      .all(intentId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: row['id'] as string,
      intentId: row['intent_id'] as string,
      eventType: row['event_type'] as WebhookEvent['type'],
      url: row['url'] as string,
      status: (row['status'] as number | null) ?? null,
      attempts: row['attempts'] as number,
      error: (row['error'] as string | null) ?? null,
      createdAt: row['created_at'] as number,
      updatedAt: row['updated_at'] as number,
      delivered: Number(row['delivered']) === 1,
    }))
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
