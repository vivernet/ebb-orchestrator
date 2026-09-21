import { useState, useEffect } from 'react';

interface SanitizedTerminalProps {
  logs: string[];
  maxHeight?: string;
}

/**
 * Очищает вывод терминала от ANSI/OSC escape-последовательностей.
 * Это не позволяет вредоносному выводу терминала использоваться как XSS.
 */
function sanitizeTerminalOutput(text: string): string {
  // Удаляем ANSI-последовательности цветов, форматирования и управления курсором.
  // Шаблон покрывает, в частности, ESC [ ... m (SGR) и ESC [ ... H.
  // eslint-disable-next-line no-control-regex
  const ansiPattern = /\u001b\[[0-9;]*[a-zA-Z]/g;
  
  // Удаляем OSC-последовательности, например ESC ] 0 ; title BEL.
  // eslint-disable-next-line no-control-regex
  const oscPattern = /\u001b\][^\u0007]*\u0007/g;
  
  // Удаляем остальные управляющие символы, сохраняя переводы строк и табуляцию.
  // eslint-disable-next-line no-control-regex
  const controlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  
  return text
    .replace(ansiPattern, '')
    .replace(oscPattern, '')
    .replace(controlPattern, '');
}

/**
 * Представляет пользовательский экран SanitizedTerminal; авторитетные проверки выполняются backend.
 */
export default function SanitizedTerminal({ logs, maxHeight = '400px' }: SanitizedTerminalProps) {
  const [scrollRef, setScrollRef] = useState<HTMLPreElement | null>(null);

  // Прокручиваем область к последней записи после поступления новых логов.
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
