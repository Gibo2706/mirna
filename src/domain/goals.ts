import type { PlannedEvent, SavingsGoal, SavingsGoalLifecycle, SavingsGoalType } from './types';

export function inferLegacyGoalType(
  goal: Pick<SavingsGoal, 'id' | 'linkedAccountId'>,
  plannedEvents: ReadonlyArray<Pick<PlannedEvent, 'linkedGoalId' | 'accountId'>>,
): SavingsGoalType {
  return plannedEvents.some(
    (event) => event.linkedGoalId === goal.id && event.accountId === goal.linkedAccountId,
  )
    ? 'sinking'
    : 'reserve';
}

export function getGoalLifecycle(
  goal: Pick<SavingsGoal, 'goalType' | 'targetAmount' | 'usedAt'>,
  linkedBalance: number,
): SavingsGoalLifecycle {
  if (goal.goalType === 'sinking' && goal.usedAt) return 'used';
  return Math.max(0, linkedBalance) >= goal.targetAmount ? 'funded' : 'active';
}

export function isGoalCompletionEvent(
  goal: Pick<SavingsGoal, 'id' | 'goalType' | 'linkedAccountId'>,
  event: Pick<PlannedEvent, 'linkedGoalId' | 'accountId'>,
): boolean {
  return (
    goal.goalType === 'sinking' &&
    event.linkedGoalId === goal.id &&
    event.accountId === goal.linkedAccountId
  );
}
