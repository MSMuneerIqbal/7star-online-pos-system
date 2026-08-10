/**
 * Chart of accounts, vouchers and ledger tests.
 * Every test runs inside a rolled-back transaction.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC, isDebitNormal } from '../src/accounting/accounts.js';
import { postVoucher } from '../src/accounting/rules/voucher.js';
import { postJournal } from '../src/accounting/post.js';
import {
  allocateAccountCode,
  bucketBase,
  bucketCeiling,
  createPartyAccount,
} from '../src/modules/accounts/service.js';
import { closeDb, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const BRANCH = 9400;

afterAll(async () => {
  await closeDb();
});

describe('account code composition', () => {
  it('reproduces the legacy allocation bases', () => {
    // These three appear as literals in CustomerController, SupplierController
    // and EmployeeController. If the composition is wrong, migrated party
    // accounts land in the wrong range.
    expect(bucketBase({ headCode: 1, subCode: 1, thirdCode: 2 })).toBe(1010200); // customer
    expect(bucketBase({ headCode: 2, subCode: 1, thirdCode: 1 })).toBe(2010100); // supplier
    expect(bucketBase({ headCode: 5, subCode: 2, thirdCode: 1 })).toBe(5020100); // employee
  });

  it('composes the fixed posting accounts correctly', () => {
    expect(bucketBase({ headCode: 1, subCode: 1, thirdCode: 1 }) + 1).toBe(ACC.CASH);
    expect(bucketBase({ headCode: 4, subCode: 1, thirdCode: 1 }) + 1).toBe(ACC.SALES);
    expect(bucketBase({ headCode: 5, subCode: 1, thirdCode: 1 }) + 1).toBe(ACC.COGS);
  });

  it('caps a bucket at 99 accounts', () => {
    const bucket = { headCode: 1, subCode: 1, thirdCode: 2 };
    expect(bucketCeiling(bucket)).toBe(1010299);
  });
});

describe('account allocation', () => {
  /**
   * A third-level group nothing else uses, so the bucket starts empty.
   *
   * Deliberately NOT the real customer bucket (thirdCode 2): those accounts
   * have committed ledger entries, and clearing them to force an empty bucket
   * is correctly refused by the transactions foreign key.
   */
  const bucket = { headCode: 1, subCode: 1, thirdCode: 90 };

  it('starts at base + 1 in an empty bucket', async () => {
    const code = await inRollback(async (tx) => {
      await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: [ACC.CASH] });
      return allocateAccountCode(tx, bucket);
    });

    expect(code).toBe(bucketBase(bucket) + 1); // 1019001
  });

  it('hands out consecutive codes without collision', async () => {
    const codes = await inRollback(async (tx) => {
      await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: [ACC.CASH] });

      const out: number[] = [];
      for (let i = 0; i < 3; i++) {
        out.push(
          await createPartyAccount(tx, {
            name: `Customer ${i}`,
            bucket,
            headId: 1,
            subHeadId: 1,
            branchId: BRANCH,
            createdBy: 0,
          }),
        );
      }
      return out;
    });

    const base = bucketBase(bucket);
    // The legacy MAX()+1 could hand the same code to two concurrent callers.
    expect(codes).toEqual([base + 1, base + 2, base + 3]);
    expect(new Set(codes).size).toBe(3);
  });

  it('refuses to overflow a full bucket rather than colliding with the next', async () => {
    // Without this guard, allocation would spill into the neighbouring bucket
    // and silently mis-classify an account.
    await expect(
      inRollback(async (tx) => {
        await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: [ACC.CASH] });

        await tx
          .insertInto('account')
          .values({
            name: 'Last in bucket',
            account_id: bucketCeiling(bucket),
            head_id: 1,
            sub_head_id: 1,
            head_code: bucket.headCode,
            sub_code: bucket.subCode,
            third_code: bucket.thirdCode,
          })
          .execute();

        return allocateAccountCode(tx, bucket);
      }),
    ).rejects.toThrow(/is full/i);
  });
});

describe('voucher posting', () => {
  const ACCOUNTS = [ACC.CASH, ACC.BANK, ACC.SALES, 5020199];

  async function seed(tx: Tx) {
    await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: ACCOUNTS });
  }

  it('persists a balanced cash receipt', async () => {
    const legs = await inRollback(async (tx) => {
      await seed(tx);

      const journal = postVoucher({
        invId: 1,
        date: '2026-04-01',
        branchId: BRANCH,
        type: 'CRV',
        lines: [
          { accountId: ACC.CASH, dr: '5000.00', cr: '0.00', detail: 'Cash in' },
          { accountId: ACC.SALES, dr: '0.00', cr: '5000.00', detail: 'Misc income' },
        ],
      });

      const posted = await postJournal(tx, journal);

      return tx
        .selectFrom('transactions')
        .selectAll()
        .where('trans_id', '=', posted.transId)
        .execute();
    });

    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.vtype === 'CRV')).toBe(true);
    expect(legs.find((l) => l.account_id === ACC.CASH)?.dr).toBe('5000.00');
  });

  it('rejects an unbalanced voucher before it reaches the database', async () => {
    // The check the legacy UI never performed.
    expect(() =>
      postVoucher({
        invId: 1,
        date: '2026-04-01',
        branchId: BRANCH,
        type: 'JV',
        lines: [
          { accountId: 5020199, dr: '500.00', cr: '0.00', detail: 'Expense' },
          { accountId: ACC.CASH, dr: '0.00', cr: '400.00', detail: 'Cash' },
        ],
      }),
    ).toThrow(/does not balance/i);
  });

  it('supports a multi-line journal voucher', async () => {
    const legs = await inRollback(async (tx) => {
      await seed(tx);

      const posted = await postJournal(
        tx,
        postVoucher({
          invId: 2,
          date: '2026-04-02',
          branchId: BRANCH,
          type: 'JV',
          lines: [
            { accountId: 5020199, dr: '300.00', cr: '0.00', detail: 'Salaries' },
            { accountId: ACC.BANK, dr: '0.00', cr: '300.00', detail: 'Paid by bank' },
          ],
        }),
      );

      return tx
        .selectFrom('transactions')
        .selectAll()
        .where('trans_id', '=', posted.transId)
        .execute();
    });

    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.vtype === 'JV')).toBe(true);
  });
});

describe('ledger balance direction', () => {
  it('treats assets and expenses as debit-normal, everything else credit-normal', () => {
    // From LedgerController.cs:50. Drives opening balances and every statement.
    expect(isDebitNormal(1)).toBe(true); // assets
    expect(isDebitNormal(5)).toBe(true); // expenses
    expect(isDebitNormal(2)).toBe(false); // liabilities
    expect(isDebitNormal(3)).toBe(false); // equity
    expect(isDebitNormal(4)).toBe(false); // revenue
  });
});
