import { format, parseISO } from 'date-fns';
import { srLatn } from 'date-fns/locale';

export const todayIso = (): string => format(new Date(), 'yyyy-MM-dd');
export const currentMonthKey = (date = new Date()): string => format(date, 'yyyy-MM');
export const monthKeyFromDate = (date: Date): string => format(date, 'yyyy-MM');
export const formatDate = (date: string): string => format(parseISO(date), 'dd.MM.yyyy');
export const formatMonth = (month: string): string =>
  format(parseISO(`${month}-01`), 'LLLL yyyy', { locale: srLatn });
