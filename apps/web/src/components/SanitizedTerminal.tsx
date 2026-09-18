import { useState, useEffect } from 'react';

interface SanitizedTerminalProps {
  logs: string[];
  maxHeight?: string;
}

/**
 * Sanitizes terminal output by stripping ANSI/OSC escape sequences.
 * This prevents XSS via malicious terminal output.
 */
function sanitizeTerminalOutput(text: string): string {
  // Strip ANSI escape sequences (colors, formatting, etc.)
  // Pattern matches: ESC [ ... (m (SGR), ESC [ ... H (cursor), etc.
  // eslint-disable-next-line no-control-regex
  const ansiPattern = /\u001b\[[0-9;]*[a-zA-Z]/g;
  
  // Strip OSC (Operating System Command) sequences like ESC ] 0 ; title BEL
  // eslint-disable-next-line no-control-regex
  const oscPattern = /\u001b\][^\u0007]*\u0007/g;
  
  // Also strip other control characters (except newlines and tabs for formatting)
  // eslint-disable-next-line no-control-regex
  const controlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  
  return text
    .replace(ansiPattern, '')
    .replace(oscPattern, '')
    .replace(controlPattern, '');
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export default function SanitizedTerminal({ logs, maxHeight = '400px' }: SanitizedTerminalProps) {
  const [scrollRef, setScrollRef] = useState<HTMLPreElement | null>(null);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight;
    }
  }, [logs, scrollRef]);

  return (
    <pre
      ref={setScrollRef}
      className="sanitized-terminal"
      style={{
        overflowY: 'auto',
        maxHeight,
        backgroundColor: '#1a1a1a',
        color: '#e0e0e0',
        padding: '12px',
        borderRadius: '4px',
        fontFamily: 'monospace',
        fontSize: '12px',
        margin: 0,
      }}
      aria-label="Terminal output"
    >
      {logs.map((log, index) => (
        <div key={index} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {sanitizeTerminalOutput(log)}
        </div>
      ))}
    </pre>
  );
}
