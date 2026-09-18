import { useMemo, type SelectHTMLAttributes } from 'react';
import { calculateAccountBalances } from '@/domain/calculations';
import type { FinanceSnapshot } from '@/domain/types';
import { Select } from '@/components/ui/Field';
import { formatRsd } from '@/lib/format';

export const AccountPicker = ({
  snapshot,
  accountIds,
  placeholder = 'Izaberite račun',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  snapshot: FinanceSnapshot;
  accountIds?: string[];
  placeholder?: string;
}) => {
  const balances = useMemo(
    () => calculateAccountBalances(snapshot.accounts, snapshot.transactions),
    [snapshot.accounts, snapshot.transactions],
  );
  const accounts = snapshot.accounts.filter((account) =>
    accountIds ? accountIds.includes(account.id) : !account.archived,
  );
  return (
    <Select {...props}>
      <option value="">{placeholder}</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.name} · {formatRsd(balances[account.id] ?? 0)}
          {account.protected ? ' · štednja' : ''}
        </option>
      ))}
    </Select>
  );
};
