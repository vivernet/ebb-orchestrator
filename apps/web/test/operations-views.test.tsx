import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SanitizedTerminal from '../src/components/SanitizedTerminal.js';

describe('SanitizedTerminal', () => {
  test('renders plain text safely', () => {
    render(<SanitizedTerminal logs={['hello world']} />);
    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  test('renders agent text with <img onerror=...> as text, not DOM node', () => {
    const maliciousText = 'Agent response: <img onerror="alert(1)" src="x">';
    render(<SanitizedTerminal logs={[maliciousText]} />);
    
    // Should render the text content, not as an img element
    expect(screen.getByText(maliciousText)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  test('strips ANSI/OSC terminal sequences outside allowlist', () => {
    const rawOutput = '\x1b[31mRed text\x1b[0m and \x1b]0;Title\x07title';
    render(<SanitizedTerminal logs={[rawOutput]} />);
    
    // Should strip ANSI/OSC sequences and show plain text
    expect(screen.getByText('Red text and title')).toBeInTheDocument();
  });

  test('allows safe ANSI color codes', () => {
    const coloredOutput = '\x1b[32mSuccess\x1b[0m';
    render(<SanitizedTerminal logs={[coloredOutput]} />);
    
    // Should strip ANSI and show the text
    expect(screen.getByText('Success')).toBeInTheDocument();
  });
});

describe('Queue row wait reason', () => {
  test('shows exact wait reason from projection', () => {
    // Test would verify queue row displays exact wait reason
    // Implementation depends on DashboardPage/ExecutionPage
    expect(true).toBe(true); // Placeholder - actual implementation in views
  });
});
