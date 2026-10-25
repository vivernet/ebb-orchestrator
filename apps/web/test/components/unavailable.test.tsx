import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UnsupportedBlock, { unsupportedReasonLabel } from '../../src/components/ui/Unavailable.js';

describe('Unavailable contract block', () => {
  test('renders localized title and reason label by default', () => {
    render(<UnsupportedBlock />);
    expect(screen.getByText('Недоступно')).toBeInTheDocument();
    expect(screen.getByText('авторитетный источник недоступен')).toBeInTheDocument();
  });

  test('renders supplied label and maps wire reason to localized reason', () => {
    render(<UnsupportedBlock label="Список согласований" reason="NO_APPROVED_POLICY" />);
    expect(screen.getByText('Список согласований')).toBeInTheDocument();
    expect(screen.getByText('нет одобренной evidence-backed политики классификации')).toBeInTheDocument();
    expect(screen.queryByText(/NO_APPROVED_POLICY/)).not.toBeInTheDocument();
  });

  test('unknown reason falls back to default reason copy', () => {
    expect(unsupportedReasonLabel('SOME_UNKNOWN')).toBe('авторитетный источник недоступен');
    expect(unsupportedReasonLabel(null)).toBe('авторитетный источник недоступен');
  });
});
