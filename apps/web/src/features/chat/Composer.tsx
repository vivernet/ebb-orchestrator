import { useState, type FormEvent } from 'react';
import { ru } from '../../i18n/ru.js';

/** Входные данные отправки сообщения из Composer. */
export interface ComposerSubmitInput {
  content: string;
  asPlanningRequest: boolean;
  requestId?: string;
}

interface ComposerProps {
  disabled?: boolean;
  /** requestId открытого NEEDS_INPUT: включает режим продолжения беседы. */
  continuationRequestId?: string | null;
  onSend: (input: ComposerSubmitInput) => Promise<void>;
}

/**
 * Форма ввода сообщения координатору; при продолжении NEEDS_INPUT отправляет
 * запрос планирования со связкой существующего requestId.
 */
export default function Composer({ disabled, continuationRequestId, onSend }: ComposerProps) {
  const [content, setContent] = useState('');
  const [asPlanning, setAsPlanning] = useState(true);
  const [busy, setBusy] = useState(false);
  const continuation = continuationRequestId != null;
  const effectivePlanning = continuation || asPlanning;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!text || busy || disabled) return;
    const input: ComposerSubmitInput = { content: text, asPlanningRequest: effectivePlanning };
    if (continuationRequestId != null) input.requestId = continuationRequestId;
    setBusy(true);
    try {
      await onSend(input);
      setContent('');
    } catch {
      // Текст сохраняется для повторной отправки.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {continuation && <div className="composer__hint">{ru.chat.continueHint(continuationRequestId as string)}</div>}
      <div className="composer__row">
        <input
          type="text"
          className="composer__input"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={ru.chat.placeholder}
          aria-label={ru.chat.placeholder}
          disabled={disabled || busy}
        />
        <label className="composer__planning">
          <input
            type="checkbox"
            checked={effectivePlanning}
            disabled={disabled || busy || continuation}
            onChange={(event) => setAsPlanning(event.target.checked)}
          />
          <span>{ru.chat.asPlanningRequest}</span>
        </label>
        <button type="submit" className="composer__send" disabled={disabled || busy || content.trim().length === 0}>
          {ru.chat.send}
        </button>
      </div>
    </form>
  );
}
