import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { createQueryStore } from '../src/state/query-store.js';
import { useQuery } from '../src/state/use-query.js';

describe('useQuery', () => {
  test('subscribes to loading and success state without optimistic data', async () => {
    let resolve: ((value: { value: string }) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<{ value: string }>((done) => { resolve = done; }));
    const store = createQueryStore();

    function Probe() {
      const result = useQuery(store, '/dashboard', undefined, fetcher);
      return <output>{result.status}:{result.data?.value ?? ''}</output>;
    }

    render(<Probe />);
    expect(screen.getByText('loading:')).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    resolve?.({ value: 'authoritative' });
    await waitFor(() => expect(screen.getByText('success:authoritative')).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('renders query errors from the shared store', async () => {
    const store = createQueryStore();
    const fetcher = vi.fn().mockRejectedValue(new Error('load failed'));

    function Probe() {
      const result = useQuery(store, '/settings', undefined, fetcher);
      const message = result.error instanceof Error ? result.error.message : '';
      return <output>{result.status}:{message}</output>;
    }

    render(<Probe />);
    await waitFor(() => expect(screen.getByText('error:load failed')).toBeInTheDocument());
  });

  test('keeps a shared request alive when one consumer unmounts', async () => {
    const store = createQueryStore();
    let signal: AbortSignal | undefined;
    let resolve: ((value: { value: string }) => void) | undefined;
    const fetcher = vi.fn((requestSignal: AbortSignal) => {
      signal = requestSignal;
      return new Promise<{ value: string }>((done) => { resolve = done; });
    });

    function Probe({ label }: { label: string }) {
      const result = useQuery(store, '/events', undefined, fetcher);
      return <output data-testid={label}>{result.status}:{result.data?.value ?? ''}</output>;
    }

    const view = render(<><Probe key="first" label="first" /><Probe key="second" label="second" /></>);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    view.rerender(<Probe key="second" label="second" />);
    expect(signal?.aborted).toBe(false);
    resolve?.({ value: 'shared' });
    await waitFor(() => expect(screen.getByTestId('second')).toHaveTextContent('success:shared'));
  });

  test('does not refetch when only the fetcher function identity changes', async () => {
    const store = createQueryStore();
    const firstFetcher = vi.fn<(signal: AbortSignal) => Promise<{ value: string }>>().mockResolvedValue({ value: 'first' });
    const secondFetcher = vi.fn<(signal: AbortSignal) => Promise<{ value: string }>>().mockResolvedValue({ value: 'second' });

    function Probe({ fetcher }: { fetcher: typeof firstFetcher }) {
      const result = useQuery(store, '/dashboard', undefined, fetcher);
      return <output>{result.status}:{result.data?.value ?? ''}</output>;
    }

    const view = render(<Probe fetcher={firstFetcher} />);
    await waitFor(() => expect(screen.getByText('success:first')).toBeInTheDocument());
    view.rerender(<Probe fetcher={secondFetcher} />);
    await waitFor(() => expect(screen.getByText('success:first')).toBeInTheDocument());
    expect(secondFetcher).not.toHaveBeenCalled();
  });

  test('stays idle when disabled and supports explicit manual refetch', async () => {
    const store = createQueryStore();
    const fetcher = vi.fn<(signal: AbortSignal) => Promise<{ value: string }>>().mockResolvedValue({ value: 'manual' });

    function Probe() {
      const result = useQuery(store, '/settings', undefined, fetcher, { enabled: false });
      return <><output>{result.status}:{result.data?.value ?? ''}</output><button type="button" onClick={() => void result.refetch()}>Refetch</button></>;
    }

    render(<Probe />);
    expect(screen.getByText('idle:')).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refetch' }));
    await waitFor(() => expect(screen.getByText('success:manual')).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('refetches after an error and publishes the recovered result', async () => {
    const store = createQueryStore();
    const fetcher = vi.fn<(signal: AbortSignal) => Promise<{ value: string }>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ value: 'recovered' });

    function Probe() {
      const result = useQuery(store, '/usage', undefined, fetcher);
      return <><output>{result.status}:{result.error instanceof Error ? result.error.message : result.data?.value ?? ''}</output><button type="button" onClick={() => void result.refetch()}>Retry query</button></>;
    }

    render(<Probe />);
    await waitFor(() => expect(screen.getByText('error:temporary failure')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry query' }));
    await waitFor(() => expect(screen.getByText('success:recovered')).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
