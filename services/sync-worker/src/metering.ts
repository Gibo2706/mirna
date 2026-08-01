import type { MeteredUsage } from './config/staging-budgets';
import type { Env } from './env';

const ORIGINAL_STATEMENT = Symbol('mirna-original-d1-statement');
const TRACK_STATEMENT = Symbol('mirna-track-d1-statement');

type MeteredStatement = D1PreparedStatement & {
  readonly [ORIGINAL_STATEMENT]: D1PreparedStatement;
  readonly [TRACK_STATEMENT]: boolean;
};
type MutableUsage = { -readonly [Key in keyof MeteredUsage]: MeteredUsage[Key] };

const ACCOUNTING_SQL =
  /\b(?:usage_daily_buckets|usage_rolling_totals|usage_reservations|service_flags|resource_totals|vault_resource_totals|resource_inventory)\b/iu;

const zeroUsage = (): MutableUsage => ({
  workerRequests: 0,
  d1RowsRead: 0,
  d1RowsWritten: 0,
  r2ClassA: 0,
  r2ClassB: 0,
});

const safeCounter = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Collects only application work. Budget-ledger and inventory SQL are excluded
 * because their fixed conservative allowance is reserved separately.
 */
export class RouteUsageMeter {
  readonly #usage = zeroUsage();
  #exact = true;
  #sizeAfter = 0;

  snapshot(): Readonly<{ usage: MeteredUsage; exact: boolean; sizeAfter: number }> {
    return { usage: { ...this.#usage }, exact: this.#exact, sizeAfter: this.#sizeAfter };
  }

  wrapEnvironment(env: Env): Env {
    const wrapped = Object.create(env) as Env;
    Object.defineProperties(wrapped, {
      MIRNA_SYNC_DB: { enumerable: true, value: this.#wrapDatabase(env.MIRNA_SYNC_DB) },
      MIRNA_SYNC_BUCKET: { enumerable: true, value: this.#wrapBucket(env.MIRNA_SYNC_BUCKET) },
    });
    return wrapped;
  }

  #observeD1(result: D1Result<unknown>): void {
    const rowsRead = safeCounter(result.meta.rows_read);
    const rowsWritten = safeCounter(result.meta.rows_written);
    const sizeAfter = safeCounter(result.meta.size_after);
    if (rowsRead === undefined || rowsWritten === undefined || sizeAfter === undefined) {
      this.#exact = false;
      return;
    }
    this.#sizeAfter = Math.max(this.#sizeAfter, sizeAfter);
    this.#usage.d1RowsRead += rowsRead;
    this.#usage.d1RowsWritten += rowsWritten;
    if (
      !Number.isSafeInteger(this.#usage.d1RowsRead) ||
      !Number.isSafeInteger(this.#usage.d1RowsWritten)
    ) {
      this.#exact = false;
    }
  }

  #wrapStatement(statement: D1PreparedStatement, tracked: boolean): MeteredStatement {
    const wrapped = {
      [ORIGINAL_STATEMENT]: statement,
      [TRACK_STATEMENT]: tracked,
      bind: (...values: unknown[]) => this.#wrapStatement(statement.bind(...values), tracked),
      first: async <T = Record<string, unknown>>(columnName?: string): Promise<T | null> => {
        const result = await statement.all<Record<string, unknown>>();
        if (tracked) this.#observeD1(result);
        const row = result.results[0];
        if (row === undefined) return null;
        if (columnName === undefined) return row as T;
        if (!(columnName in row)) throw new Error(`D1 column was not found: ${columnName}`);
        return row[columnName] as T;
      },
      run: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        const result = await statement.run<T>();
        if (tracked) this.#observeD1(result);
        return result;
      },
      all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        const result = await statement.all<T>();
        if (tracked) this.#observeD1(result);
        return result;
      },
      raw: async <T = unknown[]>(options?: {
        columnNames?: boolean;
      }): Promise<T[] | [string[], ...T[]]> => {
        if (tracked) this.#exact = false;
        return options?.columnNames
          ? statement.raw<T>({ columnNames: true })
          : statement.raw<T>({ columnNames: false });
      },
    };
    return wrapped as MeteredStatement;
  }

  #wrapDatabase(database: D1Database): D1Database {
    const wrapped: D1Database = {
      prepare: (query: string) =>
        this.#wrapStatement(database.prepare(query), !ACCOUNTING_SQL.test(query)),
      batch: async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        const entries = statements.map((statement) => {
          const candidate = statement as Partial<MeteredStatement>;
          return {
            statement: candidate[ORIGINAL_STATEMENT] ?? statement,
            tracked: candidate[TRACK_STATEMENT] ?? true,
          };
        });
        const results = await database.batch<T>(entries.map((entry) => entry.statement));
        results.forEach((result, index) => {
          if (entries[index]?.tracked) this.#observeD1(result);
        });
        return results;
      },
      exec: async (query: string) => {
        if (!ACCOUNTING_SQL.test(query)) this.#exact = false;
        return database.exec(query);
      },
      withSession: (constraintOrBookmark) => {
        this.#exact = false;
        return database.withSession(constraintOrBookmark);
      },
      dump: () => {
        this.#exact = false;
        return database.dump();
      },
    };
    return wrapped;
  }

  #wrapBucket(bucket: R2Bucket): R2Bucket {
    return new Proxy(bucket, {
      get: (target, property, receiver): unknown => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        const callable = value as (...args: unknown[]) => unknown;
        const operation = String(property);
        if (operation === 'put' || operation === 'list' || operation === 'createMultipartUpload') {
          return (...args: unknown[]): unknown => {
            this.#usage.r2ClassA += 1;
            return callable.apply(target, args);
          };
        }
        if (operation === 'get' || operation === 'head') {
          return (...args: unknown[]): unknown => {
            this.#usage.r2ClassB += 1;
            return callable.apply(target, args);
          };
        }
        return (...args: unknown[]): unknown => callable.apply(target, args);
      },
    });
  }
}
