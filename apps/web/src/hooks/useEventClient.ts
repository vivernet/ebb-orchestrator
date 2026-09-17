import { useEffect } from 'react';
import { eventClient } from '../api/events.js';

/**
 * Hook to initialize and manage SSE EventClient connection.
 * Connects to /events on mount and triggers refetch callback on reconnect.
 */
export function useEventClient() {
  useEffect(() => {
    // Set up refetch callback before connecting
    eventClient.setRefetchCallback(() => {
      // Dispatch a custom event that components can listen to
      window.dispatchEvent(new CustomEvent('sse-reconnect'));
    });

    // Connect to SSE events
    eventClient.connect();

    // Cleanup on unmount
    return () => {
      eventClient.disconnect();
    };
  }, []);
}

/**
 * Hook to listen for SSE reconnect events.
 * Calls the provided callback when the SSE connection reconnects.
 */
export function useOnSSEReconnect(callback: () => void) {
  useEffect(() => {
    const handleReconnect = () => callback();
    
    window.addEventListener('sse-reconnect', handleReconnect);
    return () => {
      window.removeEventListener('sse-reconnect', handleReconnect);
    };
  }, [callback]);
}
