import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AboutManager } from './AboutManager';

describe('AboutManager', () => {
  it('presents Mirna 2.4.1 as local-first with optional encrypted sync', () => {
    render(
      <MemoryRouter>
        <AboutManager />
      </MemoryRouter>,
    );

    expect(screen.getByText('Mirna 2.4.1')).toBeVisible();
    expect(screen.getByText(/opcionu end-to-end šifrovanu sinhronizaciju/i)).toBeVisible();
    expect(screen.getByText(/cloud servis može da čuva šifrovanu kopiju/i)).toBeVisible();
    expect(screen.getByText(/privatne ključeve potrebne za dešifrovanje/i)).toBeVisible();
  });
});
