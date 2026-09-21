import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProductionOrder } from '@workspace/api-client-react';

const reorderMock = vi.fn();

const order = (id: number, estado: 'ACTIVA' | 'BLOQUEADA'): ProductionOrder =>
  ({
    id,
    ancho: 1000 + id,
    micras: 30,
    camisa: '400',
    material: 'OPP',
    metrosNecesarios: 5000,
    metrosFabricados: 0,
    metrosPendientes: 5000,
    estado,
    origen: 'MANUAL',
    pedidosRelacionados: [],
    creadoEn: '2026-01-01T00:00:00.000Z',
    finalizadaEn: null,
    nota: null,
  }) as unknown as ProductionOrder;

const ACTIVE = [order(1, 'ACTIVA'), order(2, 'ACTIVA'), order(3, 'ACTIVA')];
const BLOCKED = [order(8, 'BLOQUEADA'), order(9, 'BLOQUEADA')];

vi.mock('@workspace/api-client-react', async () => {
  const actual =
    await vi.importActual<typeof import('@workspace/api-client-react')>(
      '@workspace/api-client-react',
    );
  const idle = { mutate: vi.fn(), isPending: false, isError: false, isSuccess: false };
  return {
    ...actual,
    useListOrders: (params: { status?: string }) => ({
      data: params.status === 'BLOQUEADA' ? BLOCKED : params.status === 'ACTIVA' ? ACTIVE : [],
      isLoading: false,
      isError: false,
    }),
    useReorderOrders: () => ({ ...idle, mutate: reorderMock }),
    useCreateOrder: () => idle,
    useDeleteOrder: () => idle,
    useSetOrderBlocked: () => idle,
    useFinalizeOrder: () => idle,
    useUpdateOrder: () => idle,
  };
});

const { default: Production } = await import('./production');

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Production canManage />
    </QueryClientProvider>,
  );
};

/** Ids enviados al servidor en la última llamada de reordenación. */
const lastReorder = () => reorderMock.mock.calls.at(-1)![0].data;

describe('Prioridad manual de órdenes en Producción', () => {
  beforeEach(() => reorderMock.mockClear());

  it('permite subir y bajar también las órdenes bloqueadas', () => {
    renderPage();

    // La lista bloqueada tiene los mismos controles que la activa.
    expect(screen.getByTestId('button-move-order-up-9')).toBeDefined();
    expect(screen.getByTestId('button-move-order-down-8')).toBeDefined();

    fireEvent.click(screen.getByTestId('button-move-order-up-9'));
    expect(lastReorder()).toEqual({ estado: 'BLOQUEADA', orderIds: [9, 8] });
  });

  it('envía el estado de la lista activa al reordenar', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('button-move-order-down-1'));
    expect(lastReorder()).toEqual({ estado: 'ACTIVA', orderIds: [2, 1, 3] });
  });

  it('el modal de posición mueve la orden al puesto elegido de una vez', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('button-position-order-1'));
    const list = screen.getByTestId('list-order-positions');
    // Se listan las tres activas y la posición actual queda marcada.
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getByText('Actual')).toBeDefined();
    expect(screen.getByTestId('button-order-position-1').hasAttribute('disabled')).toBe(true);

    // Salto directo de la primera a la tercera posición, sin pulsar Bajar dos veces.
    fireEvent.click(screen.getByTestId('button-order-position-3'));
    expect(lastReorder()).toEqual({ estado: 'ACTIVA', orderIds: [2, 3, 1] });
  });

  it('el modal de posición también opera sobre la lista bloqueada', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('button-position-order-9'));
    const list = screen.getByTestId('list-order-positions');
    expect(within(list).getAllByRole('button')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('button-order-position-1'));
    expect(lastReorder()).toEqual({ estado: 'BLOQUEADA', orderIds: [9, 8] });
  });
});
