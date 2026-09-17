import { describe, test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import App from '../src/app/App.js';

describe('AppShell', () => {
  test('renders persistent left navigation with all required menu items', () => {
    render(<App />);

    // Assert persistent left navigation includes all required items
    const nav = screen.getByRole('navigation', { name: /left nav/i });
    expect(within(nav).getByText('Dashboard')).toBeInTheDocument();
    expect(within(nav).getByText('Projects')).toBeInTheDocument();
    expect(within(nav).getByText('Approvals')).toBeInTheDocument();
    expect(within(nav).getByText('Execution')).toBeInTheDocument();
    expect(within(nav).getByText('Usage')).toBeInTheDocument();
    expect(within(nav).getByText('Settings')).toBeInTheDocument();
  });
});
