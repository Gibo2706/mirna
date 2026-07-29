import { useEffect, useState } from 'react';

/**
 * Keeps date-sensitive planning views correct across midnight and mobile PWA
 * resume without forcing a page reload.
 */
export const useCurrentDate = (): Date => {
  const [currentDate, setCurrentDate] = useState(() => new Date());

  useEffect(() => {
    let midnightTimer = 0;
    const refresh = () => {
      const now = new Date();
      setCurrentDate(now);
      window.clearTimeout(midnightTimer);
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      midnightTimer = window.setTimeout(refresh, nextMidnight.getTime() - now.getTime());
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    refresh();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      window.clearTimeout(midnightTimer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);

  return currentDate;
};
