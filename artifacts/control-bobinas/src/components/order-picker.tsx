import { type KeyboardEvent, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ProductionOrder } from '@workspace/api-client-react';
import { MaterialChip } from '@/components/material-chip';
import { formatMeters, formatPedidosSummary } from '@/lib/domain';

type OrderPickerProps = {
  orders: ProductionOrder[];
  value: number | null;
  onChange: (orderId: number) => void;
};

function OrderSummary({ order }: { order: ProductionOrder }) {
  const pedidos = order.pedidosRelacionados && order.pedidosRelacionados.length > 0
    ? formatPedidosSummary(order.pedidosRelacionados)
    : null;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      {/* El material va primero: es lo que distingue dos órdenes del mismo ancho. */}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MaterialChip material={order.material} size="md" testId={`order-picker-material-${order.id}`} />
        <span className="text-base font-semibold text-foreground">{order.ancho} mm · {order.micras} µ</span>
        <span className="text-sm text-muted-foreground">Camisa <strong className="text-foreground">{order.camisa}</strong></span>
      </span>
      <span className="text-xs text-muted-foreground">
        #{order.id}{pedidos ? ` · ${pedidos}` : ''} · pendientes {formatMeters(order.metrosPendientes)} m
      </span>
    </span>
  );
}

/**
 * Selector de orden de producción con el material en color. Sustituye al
 * <select> nativo, que solo admite texto plano. La lista se despliega dentro
 * del propio modal (sin portal) para no pelear con su scroll ni su z-index.
 */
export function OrderPicker({ orders, value, onChange }: OrderPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = orders.find((order) => order.id === value) ?? null;

  const choose = (orderId: number) => {
    onChange(orderId);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="space-y-1.5" onKeyDown={handleKeyDown}>
      <span id="order-picker-label" className="block text-xs font-semibold uppercase tracking-[.1em] text-muted-foreground">Orden de producción</span>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="order-picker-label"
        className={`pressable flex min-h-12 w-full items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-left outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/25 ${open ? 'border-primary' : 'border-input'}`}
        data-testid="select-manufactured-order"
      >
        {selected ? <OrderSummary order={selected} /> : <span className="flex-1 text-base text-muted-foreground">Selecciona una orden</span>}
        <ChevronDown size={18} className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul role="listbox" aria-labelledby="order-picker-label" className="max-h-80 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-muted/30 p-1.5" data-testid="list-manufactured-orders">
          {orders.map((order) => {
            const isSelected = order.id === value;
            return (
              <li key={order.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => choose(order.id)}
                  className={`pressable flex min-h-12 w-full items-center gap-3 rounded-md border px-3 py-2.5 transition hover:bg-muted ${isSelected ? 'border-primary bg-primary/5' : 'border-transparent bg-card'}`}
                  data-testid={`option-manufactured-order-${order.id}`}
                >
                  <OrderSummary order={order} />
                  {isSelected && <Check size={18} className="shrink-0 text-primary" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
