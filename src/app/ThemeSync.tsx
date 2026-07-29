import { useEffect } from 'react';
import type { Appearance } from '@/domain/types';

export const ThemeSync = ({ appearance }: { appearance: Appearance }) => {
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = appearance === 'dark' || (appearance === 'system' && query.matches);
      document.documentElement.classList.toggle('dark', dark);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#101311' : '#f6f6f3');
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [appearance]);
  return null;
};
