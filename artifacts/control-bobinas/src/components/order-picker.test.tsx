import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ProductionOrder } from '@workspace/api-client-react';
import { OrderPicker } from './order-picker';
import { getMaterialColorClass } from '@/lib/domain';

const order = (id: number, material: string, camisa: string): ProductionOrder =>
  ({
    id,
    ancho: 980,
    micras: 25,
    camisa,
    material,
    metrosNecesarios: 6800,
    metrosFabricados: 0,
    metrosPendientes: 6800,
    estado: 'BLOQUEADA',
    origen: 'MANUAL',
    pedidosRelacionados: [],
    creadoEn: '2026-01-01T00:00:00.000Z',
    finalizadaEn: null,
    nota: null,
  }) as unknown as ProductionOrder;

// Caso real de los carretilleros: dos órdenes con el mismo ancho y distinto material.
const ORDERS = [order(78, 'OPP TTE', '40-8-40'), order(79, 'OPP RECICLADO', '47-8-47')];

describe('OrderPicker', () => {
  it('muestra material en color y camisa en cada opción', () => {
    render(<OrderPicker orders={ORDERS} value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('select-manufactured-order'));

    const tte = screen.getByTestId('option-manufactured-order-78');
    const reciclado = screen.getByTestId('option-manufactured-order-79');

    const tteChip = within(tte).getByTestId('order-picker-material-78');
    expect(tteChip.textContent).toBe('OPP TTE');
    expect(tteChip.className).toContain(getMaterialColorClass('OPP TTE'));
    expect(tte.textContent).toContain('40-8-40');

    const recicladoChip = within(reciclado).getByTestId('order-picker-material-79');
    expect(recicladoChip.textContent).toBe('OPP RECICLADO');
    expect(recicladoChip.className).toContain(getMaterialColorClass('OPP RECICLADO'));
    expect(reciclado.textContent).toContain('47-8-47');
  });

  it('al elegir una orden avisa del id y cierra la lista', () => {
    const onChange = vi.fn();
    render(<OrderPicker orders={ORDERS} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('select-manufactured-order'));
    fireEvent.click(screen.getByTestId('option-manufactured-order-79'));

    expect(onChange).toHaveBeenCalledWith(79);
    expect(screen.queryByTestId('list-manufactured-orders')).toBeNull();
  });

  it('la orden elegida se ve en el botón con su material', () => {
    render(<OrderPicker orders={ORDERS} value={79} onChange={() => {}} />);
    const trigger = screen.getByTestId('select-manufactured-order');
    expect(within(trigger).getByTestId('order-picker-material-79').textContent).toBe('OPP RECICLADO');
  });
});
