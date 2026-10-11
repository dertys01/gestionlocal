import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * useRealtimeRefresh — le rafraîchissement multi-caisses.
 *
 * `NEXT_PUBLIC_REALTIME` décide au chargement du module : sans « 1 », le hook
 * est INERTE (aucune connexion WebSocket ouverte, donc rien de facturé). Avec,
 * il s'abonne table par table, filtre sur le tenant, et regroupe les écritures
 * en rafale (debounce) avant d'appeler `onChange`.
 */

const h = vi.hoisted(() => {
  const handlers: Array<() => void> = [];
  const channel: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockImplementation((_event: unknown, _filter: unknown, cb: () => void) => { handlers.push(cb); return channel; });
  channel.subscribe.mockImplementation(() => channel);
  const removeChannel = vi.fn();
  const supabase = { channel: vi.fn(() => channel), removeChannel };
  return { handlers, channel, supabase, removeChannel };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, ownerId: 'org-1' }),
}));

async function importer(actif: boolean) {
  vi.resetModules();
  if (actif) process.env.NEXT_PUBLIC_REALTIME = '1';
  else delete process.env.NEXT_PUBLIC_REALTIME;
  return await import('@/lib/hooks/useRealtimeRefresh');
}

afterEach(() => {
  vi.useRealTimers();
  h.handlers.length = 0;
  h.channel.on.mockClear();
  h.channel.subscribe.mockClear();
  h.supabase.channel.mockClear();
  h.removeChannel.mockClear();
  delete process.env.NEXT_PUBLIC_REALTIME;
});

describe('useRealtimeRefresh', () => {
  it('inerte sans NEXT_PUBLIC_REALTIME : n’ouvre aucun canal', async () => {
    const { useRealtimeRefresh } = await importer(false);
    renderHook(() => useRealtimeRefresh(['products'], () => {}));

    expect(h.supabase.channel).not.toHaveBeenCalled();
  });

  it('s’abonne par table, filtré sur le tenant', async () => {
    const { useRealtimeRefresh } = await importer(true);
    renderHook(() => useRealtimeRefresh(['products', 'sales'], () => {}));

    expect(h.supabase.channel).toHaveBeenCalledWith('gl:products,sales:org-1');
    expect(h.channel.on).toHaveBeenCalledTimes(2);
    expect(h.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'products', filter: 'user_id=eq.org-1' },
      expect.any(Function),
    );
    expect(h.channel.subscribe).toHaveBeenCalled();
  });

  it('filtre les tables restaurant sur leur vraie colonne de tenant', async () => {
    const { useRealtimeRefresh } = await importer(true);
    renderHook(() => useRealtimeRefresh(['restaurant_orders', 'restaurant_order_items'], () => {}));

    // restaurant_orders → owner_id (pas user_id) ; restaurant_order_items →
    // AUCUN filtre (elle n'a pas de colonne de tenant), la RLS fait le tri.
    expect(h.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'restaurant_orders', filter: 'owner_id=eq.org-1' },
      expect.any(Function),
    );
    expect(h.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'restaurant_order_items' },
      expect.any(Function),
    );
  });

  it('regroupe les écritures en rafale et n’appelle onChange qu’une fois', async () => {
    vi.useFakeTimers();
    const { useRealtimeRefresh } = await importer(true);
    const onChange = vi.fn();
    renderHook(() => useRealtimeRefresh(['products'], onChange));

    act(() => {
      h.handlers[0]();
      h.handlers[0]();
      h.handlers[0]();
    });
    act(() => { vi.advanceTimersByTime(500); });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('retire le canal au démontage', async () => {
    const { useRealtimeRefresh } = await importer(true);
    const { unmount } = renderHook(() => useRealtimeRefresh(['products'], () => {}));

    const avant = h.removeChannel.mock.calls.length;
    unmount();
    expect(h.removeChannel.mock.calls.length).toBeGreaterThan(avant);
  });
});
