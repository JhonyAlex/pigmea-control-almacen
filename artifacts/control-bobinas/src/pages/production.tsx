import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownUp, CheckCircle2, ChevronDown, ChevronUp, ClipboardPlus, Factory, FileDown, Layers, Lock, Package, RefreshCw, Trash2, TriangleAlert, Unlock, X } from 'lucide-react';
import {
  getListOrdersQueryKey,
  OrderStatus,
  useCreateOrder,
  useDeleteOrder,
  useDeleteOrderPedido,
  useFinalizeOrder,
  useListOrders,
  useReorderOrders,
  useSetOrderBlocked,
  useUpdateOrder,
  type OrderReorderStatus,
  type ProductionOrder,
} from '@workspace/api-client-react';
import { Field, inputClass, Modal } from '@/components/modal';
import { MaterialChip } from '@/components/material-chip';
import { CAMISAS, formatDate, formatMeters, formatPedidosSummary, MATERIALES, parseCamisa } from '@/lib/domain';
import { exportProductionOrdersPDF } from '@/utils/productionOrdersPdf';

function OrderSkeleton() {
  return <div className="space-y-3" aria-label="Cargando órdenes" data-testid="loading-orders"><div className="h-44 animate-pulse rounded-xl bg-muted" /><div className="h-44 animate-pulse rounded-xl bg-muted" /></div>;
}

// Surfaces the API's error message (e.g. ORDER_CHARACTERISTICS_LOCKED) when
// the server explains why the save failed; falls back to a generic text.
const serverErrorMessage = (error: unknown): string | null => {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && 'error' in data) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
};

const serverErrorFaltantes = (error: unknown): number | null => {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && 'faltantes' in data) {
    const faltantes = (data as { faltantes?: unknown }).faltantes;
    if (typeof faltantes === 'number' && Number.isFinite(faltantes)) return faltantes;
  }
  return null;
};

const serverErrorCode = (error: unknown): string | null => {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && 'code' in data) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
};

function Production({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const ordersQuery = useListOrders({ status: OrderStatus.ACTIVA });
  const blockedOrdersQuery = useListOrders({ status: OrderStatus.BLOQUEADA });
  const createOrder = useCreateOrder();
  const deleteOrder = useDeleteOrder();
  const deleteOrderPedido = useDeleteOrderPedido();
  const setOrderBlocked = useSetOrderBlocked();
  const finalizeOrder = useFinalizeOrder();
  const reorderOrders = useReorderOrders();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductionOrder | null>(null);
  const [editTarget, setEditTarget] = useState<ProductionOrder | null>(null);
  const [blockTarget, setBlockTarget] = useState<ProductionOrder | null>(null);
  const [finalizeTarget, setFinalizeTarget] = useState<ProductionOrder | null>(null);
  const [finalizeNote, setFinalizeNote] = useState<string>('');
  const [finalizeForzar, setFinalizeForzar] = useState(false);
  // Metros faltantes que se están enseñando en el modal: parten de la orden y
  // se actualizan si el servidor devuelve un dato más fresco al confirmar.
  const [finalizeFaltantes, setFinalizeFaltantes] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [positionTarget, setPositionTarget] = useState<{ order: ProductionOrder; estado: OrderReorderStatus } | null>(null);
  const [deletingPedidoId, setDeletingPedidoId] = useState<number | null>(null);
  const updateOrder = useUpdateOrder();

  const orders = ordersQuery.data ?? [];
  const blockedOrders = blockedOrdersQuery.data ?? [];
  const invalidateOrderQueries = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.ACTIVA }) }),
    queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.BLOQUEADA }) }),
    queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.FINALIZADA }) }),
  ]);
  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const data = {
        ancho: Number(form.get('ancho')),
        micras: Number(form.get('micras')),
        camisa: parseCamisa(String(form.get('camisa'))),
        material: String(form.get('material')) as typeof MATERIALES[number],
        metrosNecesarios: Number(form.get('metrosNecesarios')),
    };
    if (editTarget) {
      updateOrder.mutate({ id: editTarget.id, data }, {
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.ACTIVA }) }); setEditTarget(null); setNotice('Orden actualizada correctamente.'); },
      });
      return;
    }
    createOrder.mutate({
      data,
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.ACTIVA }) });
        setCreateOpen(false);
        setNotice('Orden creada y añadida a producción.');
      },
    });
  };

  const onDelete = () => {
    if (!deleteTarget) return;
    deleteOrder.mutate({ id: deleteTarget.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.ACTIVA }) });
        setDeleteTarget(null);
        setNotice('Orden eliminada de producción.');
      },
    });
  };

  const onDeletePedido = (orderId: number, pedidoRelId: number) => {
    setActionError(null);
    setDeletingPedidoId(pedidoRelId);
    deleteOrderPedido.mutate({ id: orderId, pedidoRelId }, {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.ACTIVA }) }); },
      onError: (error) => setActionError(serverErrorMessage(error) ?? 'No se pudo eliminar el pedido de la orden.'),
      onSettled: () => setDeletingPedidoId(null),
    });
  };

  const onBlock = () => {
    if (!blockTarget) return;
    setActionError(null);
    setOrderBlocked.mutate({ id: blockTarget.id, data: { blocked: true } }, {
      onSuccess: () => {
        void invalidateOrderQueries();
        setBlockTarget(null);
        setNotice(`Orden ORD-${String(blockTarget.id).padStart(4, '0')} bloqueada. Crea una nueva orden para continuar.`);
      },
      onError: () => setActionError('No se pudo bloquear la orden. Inténtalo de nuevo.'),
    });
  };

  const onUnblock = (order: ProductionOrder) => {
    setActionError(null);
    setOrderBlocked.mutate({ id: order.id, data: { blocked: false } }, {
      onSuccess: () => {
        void invalidateOrderQueries();
        setNotice(`Orden ORD-${String(order.id).padStart(4, '0')} desbloqueada y devuelta a producción.`);
      },
      onError: () => setActionError('No se pudo desbloquear la orden. Inténtalo de nuevo.'),
    });
  };

  const onFinalize = () => {
    if (!finalizeTarget) return;
    setActionError(null);
    finalizeOrder.mutate({
      id: finalizeTarget.id,
      data: {
        nota: finalizeNote.trim(),
        faltantesEsperados: finalizeFaltantes ?? finalizeTarget.metrosPendientes,
        forzar: finalizeForzar,
      },
    }, {
      onSuccess: () => {
        void invalidateOrderQueries();
        const targetId = finalizeTarget.id;
        const targetMeters = formatMeters(finalizeFaltantes ?? finalizeTarget.metrosPendientes);
        setFinalizeTarget(null);
        setFinalizeNote('');
        setFinalizeForzar(false);
        setFinalizeFaltantes(null);
        setNotice(`Orden ORD-${String(targetId).padStart(4, '0')} finalizada manualmente (${targetMeters} m faltantes). Movida al historial.`);
      },
      onError: (error) => {
        if (serverErrorCode(error) === 'FINALIZE_METERS_DEFICIT') {
          // A pedido was grouped into this order after the dialog opened
          // (e.g. by Nexus) and the deficit shown is now stale. Repaint the
          // modal with the figure the server just computed and ask for an
          // explicit second confirm over that figure.
          const faltantes = serverErrorFaltantes(error);
          if (faltantes !== null) {
            setFinalizeFaltantes(faltantes);
            setFinalizeNote(`Finalizada manualmente con ${formatMeters(faltantes)} m faltantes`);
          }
          setFinalizeForzar(true);
          setActionError(`${serverErrorMessage(error)} Se han agrupado pedidos nuevos a esta orden: revisa los metros antes de confirmar.`);
          return;
        }
        setActionError('No se pudo finalizar la orden. Inténtalo de nuevo.');
      },
    });
  };

  // Activas y bloqueadas son dos listas independientes: cada una se reordena
  // por separado y el servidor sólo reescribe las posiciones de la suya.
  const listFor = (estado: OrderReorderStatus) => (estado === OrderStatus.ACTIVA ? orders : blockedOrders);

  const submitReorder = (estado: OrderReorderStatus, reordered: ProductionOrder[]) => {
    setActionError(null);
    reorderOrders.mutate({ data: { estado, orderIds: reordered.map((order) => order.id) } }, {
      onSuccess: () => { void invalidateOrderQueries(); setPositionTarget(null); },
      onError: () => setActionError('No se pudo guardar el nuevo orden. Actualiza e inténtalo de nuevo.'),
    });
  };

  const moveOrder = (estado: OrderReorderStatus, index: number, direction: -1 | 1) => {
    const list = listFor(estado);
    const destination = index + direction;
    if (destination < 0 || destination >= list.length) return;
    const reordered = [...list];
    [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
    submitReorder(estado, reordered);
  };

  // Salto directo a una posición concreta, para no tener que pulsar Subir o
  // Bajar una vez por hueco cuando la lista es larga.
  const moveOrderToPosition = (destination: number) => {
    if (!positionTarget) return;
    const { estado, order } = positionTarget;
    const list = listFor(estado);
    const from = list.findIndex((item) => item.id === order.id);
    if (from < 0 || destination < 0 || destination >= list.length) return;
    if (from === destination) { setPositionTarget(null); return; }
    const reordered = [...list];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(destination, 0, moved);
    submitReorder(estado, reordered);
  };

  return (
    <div className="industrial-grid min-h-[calc(100dvh-72px)]">
      <div className="mx-auto max-w-[1480px] px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
        <div className="load-in mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div><p className="font-data text-[10px] font-semibold uppercase tracking-[.2em] text-primary">Módulo 02 / producción</p><h1 className="mt-2 font-display text-[clamp(2.7rem,6vw,4.7rem)] font-semibold uppercase leading-[.88] tracking-wide">Órdenes activas</h1><p className="mt-3 max-w-xl text-sm text-muted-foreground">Controla lo que está en fabricación. Cada metro registrado actualiza el pendiente de la orden.</p></div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => exportProductionOrdersPDF([...blockedOrders, ...orders])}
              disabled={orders.length === 0 && blockedOrders.length === 0}
              className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg border border-primary/25 bg-card px-4 text-sm font-semibold text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
              title="Exportar órdenes a PDF"
              data-testid="button-export-pdf"
            >
              <FileDown size={18} /> Exportar PDF
            </button>
            {canManage && <button type="button" onClick={() => { setNotice(null); setEditTarget(null); setCreateOpen(true); }} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground hover:brightness-110" data-testid="button-create-order"><ClipboardPlus size={18} /> Nueva orden</button>}
          </div>
        </div>
        {notice && <div className="mb-6 flex items-center gap-3 rounded-lg border border-[#a9c9b1] bg-[#eaf4eb] px-4 py-3 text-sm font-medium text-[#27613d]" role="status" data-testid="status-production-success"><span className="h-2 w-2 rounded-full bg-[#4c9a71]" />{notice}<button type="button" className="ml-auto text-xs uppercase tracking-wider underline" onClick={() => setNotice(null)} data-testid="button-dismiss-production-notice">Cerrar</button></div>}
        {actionError && <div className="mb-6 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm font-medium text-destructive" role="alert" data-testid="error-order-block-action">{actionError}<button type="button" className="ml-auto text-xs uppercase tracking-wider underline" onClick={() => setActionError(null)}>Cerrar</button></div>}
        {ordersQuery.isLoading && <OrderSkeleton />}
        {ordersQuery.isError && !ordersQuery.isLoading && <div className="flex flex-col items-start gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-6" role="alert" data-testid="error-orders"><div className="flex items-center gap-3 text-destructive"><TriangleAlert size={21} /><p className="font-semibold">No se pudieron cargar las órdenes</p></div><button type="button" onClick={() => ordersQuery.refetch()} className="pressable flex min-h-11 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground" data-testid="button-retry-orders"><RefreshCw size={16} /> Reintentar</button></div>}
        {!ordersQuery.isLoading && !ordersQuery.isError && (orders.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-card/60 px-6 py-16 text-center" data-testid="empty-active-orders"><Factory className="mx-auto text-muted-foreground" size={32} /><h2 className="mt-3 font-display text-3xl uppercase">Sin órdenes activas</h2><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Cuando entre una nueva necesidad de fabricación, aparecerá aquí.</p>{canManage && <button type="button" onClick={() => setCreateOpen(true)} className="pressable mt-6 min-h-12 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground" data-testid="button-create-first-order">Crear primera orden</button>}</div> : <div className="space-y-3" data-testid="list-active-orders">{orders.map((order, index) => <OrderCard key={order.id} order={order} index={index} canManage={canManage} onDelete={() => setDeleteTarget(order)} onEdit={() => setEditTarget(order)} onBlock={() => { setActionError(null); setBlockTarget(order); }} onDeletePedido={(pedidoRelId) => onDeletePedido(order.id, pedidoRelId)} deletingPedidoId={deletingPedidoId} onMoveUp={() => moveOrder(OrderStatus.ACTIVA, index, -1)} onMoveDown={() => moveOrder(OrderStatus.ACTIVA, index, 1)} onPosition={() => { setActionError(null); setPositionTarget({ order, estado: OrderStatus.ACTIVA }); }} canMoveUp={index > 0} canMoveDown={index < orders.length - 1} canPosition={orders.length > 1} actionPending={setOrderBlocked.isPending || reorderOrders.isPending} />)}</div>)}
        {!blockedOrdersQuery.isLoading && !blockedOrdersQuery.isError && blockedOrders.length > 0 && <section className="mt-10 border-t border-border pt-8" aria-labelledby="blocked-orders-title"><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="font-data text-[10px] font-semibold uppercase tracking-[.2em] text-accent-foreground">Producción detenida</p><h2 id="blocked-orders-title" className="mt-1 font-display text-3xl font-semibold uppercase tracking-wide">Órdenes bloqueadas</h2><p className="mt-1 text-sm text-muted-foreground">No se pueden usar para registrar fabricación hasta que se desbloqueen.</p></div><span className="rounded-md bg-secondary px-2.5 py-1 font-data text-[10px] font-semibold uppercase tracking-wider text-accent-foreground">{blockedOrders.length} bloqueadas</span></div><div className="space-y-3" data-testid="list-blocked-orders">{blockedOrders.map((order, index) => <OrderCard key={order.id} order={order} index={index} blocked canManage={canManage} onUnblock={() => onUnblock(order)} onFinalize={() => { setActionError(null); setFinalizeTarget(order); setFinalizeForzar(false); setFinalizeFaltantes(null); setFinalizeNote(`Finalizada manualmente con ${formatMeters(order.metrosPendientes)} m faltantes`); }} onMoveUp={() => moveOrder(OrderStatus.BLOQUEADA, index, -1)} onMoveDown={() => moveOrder(OrderStatus.BLOQUEADA, index, 1)} onPosition={() => { setActionError(null); setPositionTarget({ order, estado: OrderStatus.BLOQUEADA }); }} canMoveUp={index > 0} canMoveDown={index < blockedOrders.length - 1} canPosition={blockedOrders.length > 1} actionPending={setOrderBlocked.isPending || finalizeOrder.isPending || reorderOrders.isPending} />)}</div></section>}
        {blockedOrdersQuery.isError && <p className="mt-8 text-sm text-destructive" role="alert">No se pudieron cargar las órdenes bloqueadas.</p>}
      </div>

      <Modal open={createOpen || !!editTarget} onClose={() => { setCreateOpen(false); setEditTarget(null); }} onSubmit={onCreate} eyebrow={editTarget ? "Edición de producción" : "Plan de fabricación"} title={editTarget ? "Editar orden" : "Nueva orden"} submitLabel={createOrder.isPending || updateOrder.isPending ? 'Guardando…' : editTarget ? 'Guardar cambios' : 'Crear orden'} submitDisabled={createOrder.isPending || updateOrder.isPending}>
        {editTarget && <p className="mb-4 rounded-lg border border-accent/40 bg-accent/15 px-3 py-3 text-sm font-medium text-accent-foreground" role="alert">Advertencia: estás editando una orden de producción. Los metros ya fabricados se conservarán.</p>}
        {(createOrder.isError || updateOrder.isError) && <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="error-create-order">{(updateOrder.isError && serverErrorMessage(updateOrder.error)) ?? 'No se pudo guardar la orden. Revisa los datos.'}</p>}
        <div className="grid gap-5 sm:grid-cols-2"><Field label="Ancho" hint="mm"><input name="ancho" type="number" min="1" required className={inputClass} defaultValue={editTarget?.ancho ?? ''} placeholder="Ej. 1250" data-testid="input-order-width" /></Field><Field label="Micras"><input name="micras" type="number" min="1" required className={inputClass} defaultValue={editTarget?.micras ?? ''} placeholder="Ej. 23" data-testid="input-order-microns" /></Field><Field label="Camisa"><select name="camisa" required className={inputClass} defaultValue={editTarget?.camisa ?? ""} data-testid="select-order-sleeve"><option value="" disabled>Selecciona</option>{CAMISAS.map((camisa) => <option key={camisa} value={camisa}>{camisa}</option>)}</select></Field><Field label="Material"><select name="material" required className={inputClass} defaultValue={editTarget?.material ?? ""} data-testid="select-order-material"><option value="" disabled>Selecciona</option>{MATERIALES.map((material) => <option key={material} value={material}>{material}</option>)}</select></Field><div className="sm:col-span-2"><Field label="Metros necesarios" hint="cantidad positiva"><input name="metrosNecesarios" type="number" min="1" step="1" required className={inputClass} defaultValue={editTarget?.metrosNecesarios ?? ''} placeholder="Ej. 12.500" data-testid="input-order-meters" /></Field></div></div>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onSubmit={(event) => { event.preventDefault(); onDelete(); }} eyebrow="Acción irreversible" title="Eliminar orden" submitLabel={deleteOrder.isPending ? 'Eliminando…' : 'Eliminar orden'} submitDisabled={deleteOrder.isPending} destructive>
        {deleteTarget && <div><div className="rounded-lg border border-border bg-muted/50 p-4"><p className="font-data text-[10px] uppercase tracking-[.14em] text-muted-foreground">Orden #{deleteTarget.id}</p><p className="mt-2 flex flex-wrap items-center gap-1.5 font-semibold">{deleteTarget.ancho} mm · {deleteTarget.micras} µ · <MaterialChip material={deleteTarget.material} size="sm" /></p><p className="mt-1 text-sm text-muted-foreground">{formatMeters(deleteTarget.metrosPendientes)} m pendientes de fabricar</p>{deleteTarget.pedidosRelacionados && deleteTarget.pedidosRelacionados.length > 0 && <p className="mt-2 text-xs font-semibold text-primary">{formatPedidosSummary(deleteTarget.pedidosRelacionados)}</p>}</div><p className="mt-5 text-sm leading-relaxed text-muted-foreground">Se eliminará esta orden activa. El material ya registrado no se modifica.</p>{deleteOrder.isError && <p className="mt-3 text-sm text-destructive" role="alert" data-testid="error-delete-order">No se pudo eliminar la orden.</p>}</div>}
      </Modal>

      <Modal open={!!blockTarget} onClose={() => { setBlockTarget(null); setActionError(null); }} onSubmit={(event) => { event.preventDefault(); onBlock(); }} eyebrow="Detener producción" title="Bloquear orden" submitLabel={setOrderBlocked.isPending ? 'Bloqueando…' : 'Bloquear orden'} submitDisabled={setOrderBlocked.isPending}>
        {blockTarget && <div><div className="rounded-lg border border-accent/50 bg-secondary/60 p-4"><p className="font-data text-[10px] uppercase tracking-[.14em] text-muted-foreground">Orden ORD-{String(blockTarget.id).padStart(4, '0')}</p><p className="mt-2 flex flex-wrap items-center gap-1.5 font-semibold">{blockTarget.ancho} mm · {blockTarget.micras} µ · <MaterialChip material={blockTarget.material} size="sm" /></p><p className="mt-1 text-sm text-muted-foreground">{formatMeters(blockTarget.metrosPendientes)} m pendientes de fabricar</p>{blockTarget.pedidosRelacionados && blockTarget.pedidosRelacionados.length > 0 && <p className="mt-2 text-xs font-semibold text-primary">{formatPedidosSummary(blockTarget.pedidosRelacionados)}</p>}</div><p className="mt-5 flex gap-2 text-sm leading-relaxed text-muted-foreground"><Lock size={18} className="mt-0.5 shrink-0 text-accent-foreground" /> No se podrán registrar más bobinas ni editar esta orden. Crea una nueva para continuar; podrás desbloquearla más adelante si lo necesitas.</p>{actionError && <p className="mt-4 text-sm text-destructive" role="alert">{actionError}</p>}</div>}
      </Modal>

      <Modal open={!!positionTarget} onClose={() => { setPositionTarget(null); setActionError(null); }} eyebrow={positionTarget?.estado === OrderStatus.BLOQUEADA ? 'Órdenes bloqueadas' : 'Órdenes activas'} title="Mover a posición">
        {positionTarget && (() => {
          const list = listFor(positionTarget.estado);
          const currentIndex = list.findIndex((item) => item.id === positionTarget.order.id);
          return <div className="px-5 py-5 sm:px-7">
            <p className="text-sm leading-relaxed text-muted-foreground">Toca la posición en la que quieres situar la orden <strong className="text-foreground">ORD-{String(positionTarget.order.id).padStart(4, '0')}</strong>. Las demás se desplazan para dejarle el hueco.</p>
            <ol className="mt-5 space-y-2" data-testid="list-order-positions">
              {list.map((item, index) => {
                const isCurrent = index === currentIndex;
                return <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => moveOrderToPosition(index)}
                    disabled={reorderOrders.isPending || isCurrent}
                    className={`pressable flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 text-left transition disabled:cursor-not-allowed ${isCurrent ? 'border-primary/40 bg-primary/10' : 'border-border bg-card hover:bg-muted'}`}
                    data-testid={`button-order-position-${index + 1}`}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-data text-sm font-semibold ${isCurrent ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-data text-[11px] font-semibold text-muted-foreground">ORD-{String(item.id).padStart(4, '0')}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-foreground">{item.ancho} mm · {item.micras} µ · <MaterialChip material={item.material} size="sm" /></span>
                    </span>
                    {isCurrent && <span className="shrink-0 rounded bg-primary/15 px-2 py-0.5 font-data text-[10px] font-semibold uppercase tracking-wider text-primary">Actual</span>}
                  </button>
                </li>;
              })}
            </ol>
            {actionError && <p className="mt-4 text-sm text-destructive" role="alert" data-testid="error-order-position">{actionError}</p>}
          </div>;
        })()}
      </Modal>

      <Modal open={!!finalizeTarget} onClose={() => { setFinalizeTarget(null); setFinalizeForzar(false); setFinalizeFaltantes(null); setActionError(null); }} onSubmit={(event) => { event.preventDefault(); onFinalize(); }} eyebrow="Finalización manual" title="Finalizar orden bloqueada" submitLabel={finalizeOrder.isPending ? 'Finalizando…' : finalizeForzar ? 'Confirmar y finalizar igualmente' : 'Finalizar orden'} submitDisabled={finalizeOrder.isPending}>
        {finalizeTarget && <div><div className="rounded-lg border border-border bg-muted/50 p-4"><p className="font-data text-[10px] uppercase tracking-[.14em] text-muted-foreground">Orden ORD-{String(finalizeTarget.id).padStart(4, '0')}</p><p className="mt-2 flex flex-wrap items-center gap-1.5 font-semibold">{finalizeTarget.ancho} mm · {finalizeTarget.micras} µ · <MaterialChip material={finalizeTarget.material} size="sm" /> · Camisa {finalizeTarget.camisa}</p><div className="mt-2 flex flex-wrap gap-x-4 text-xs text-muted-foreground"><span>Fabricados: <strong className="text-foreground">{formatMeters(finalizeTarget.metrosFabricados)} m</strong></span><span>Necesarios: {formatMeters(finalizeTarget.metrosNecesarios)} m</span></div><div className="mt-3 rounded-md border border-accent/50 bg-secondary/60 p-2.5"><p className="text-xs font-medium text-accent-foreground">Metros faltantes: <strong className="font-data text-sm" data-testid="text-finalize-order-faltantes">{formatMeters(finalizeFaltantes ?? finalizeTarget.metrosPendientes)} m</strong></p></div>{finalizeTarget.pedidosRelacionados && finalizeTarget.pedidosRelacionados.length > 0 && <p className="mt-2 text-xs font-semibold text-primary">{formatPedidosSummary(finalizeTarget.pedidosRelacionados)}</p>}</div><p className="mt-4 text-sm leading-relaxed text-muted-foreground">La orden pasará al flujo de órdenes finalizadas (historial de trazabilidad) dejando constancia de los metros no completados.</p><div className="mt-4"><Field label="Nota de finalización" hint="constancia de metros faltantes"><input name="nota" type="text" required className={inputClass} value={finalizeNote} onChange={(e) => setFinalizeNote(e.target.value)} placeholder="Nota de los metros faltantes..." data-testid="input-finalize-order-note" /></Field></div>{actionError && <p className="mt-4 text-sm text-destructive" role="alert" data-testid="error-finalize-order-action">{actionError}</p>}</div>}
      </Modal>
    </div>
  );
}

function OrderCard({ order, index, onDelete, onEdit, onBlock, onUnblock, onFinalize, onDeletePedido, deletingPedidoId = null, onMoveUp, onMoveDown, onPosition, canMoveUp = false, canMoveDown = false, canPosition = false, canManage = false, blocked = false, actionPending = false }: { order: ProductionOrder; index: number; onDelete?: () => void; onEdit?: () => void; onBlock?: () => void; onUnblock?: () => void; onFinalize?: () => void; onDeletePedido?: (pedidoRelId: number) => void; deletingPedidoId?: number | null; onMoveUp?: () => void; onMoveDown?: () => void; onPosition?: () => void; canMoveUp?: boolean; canMoveDown?: boolean; canPosition?: boolean; canManage?: boolean; blocked?: boolean; actionPending?: boolean }) {
  const progress = order.metrosNecesarios > 0 ? Math.min(100, (order.metrosFabricados / order.metrosNecesarios) * 100) : 0;
  const statusClass = blocked ? 'text-[#906000]' : 'text-[#3c7d52]';
  const statusDotClass = blocked ? 'bg-accent' : 'bg-[#4c9a71]';
  const pedidos = order.pedidosRelacionados ?? [];
  return <article className={`load-in rounded-xl border bg-card p-5 sm:p-6 ${blocked ? 'border-accent/50' : 'border-border'}`} style={{ animationDelay: `${index * 55}ms` }} data-testid={`card-order-${order.id}`}>
    <div className="flex flex-col gap-5 xl:grid xl:grid-cols-[minmax(0,1fr)_410px_190px_145px] xl:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded-md bg-primary px-2.5 py-1 font-data text-[11px] font-semibold text-primary-foreground" data-testid={`text-order-id-${order.id}`}>ORD-{String(order.id).padStart(4, '0')}</span>
          <span className={`flex items-center gap-1.5 font-data text-[10px] uppercase tracking-wider ${statusClass}`}><span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} /> {order.estado}</span>
          {order.origen === 'GESTION_PEDIDOS' && <span className="rounded bg-primary/10 px-2 py-0.5 font-data text-[10px] font-semibold text-primary">Nexus</span>}
        </div>
        <h2 className="mt-3 font-display text-[2.35rem] font-semibold leading-none">{order.ancho} <span className="text-xl font-medium text-muted-foreground">mm</span><span className="mx-2 text-muted-foreground/40">/</span>{order.micras} <span className="text-xl font-medium text-muted-foreground">µ</span></h2>
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">Camisa <strong className="text-foreground">{order.camisa}</strong> <span className="mx-0.5 text-muted-foreground/40">·</span> <MaterialChip material={order.material} size="sm" testId={`text-order-material-${order.id}`} /></p>
        {pedidos.length === 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid={`order-single-pedido-${order.id}`}>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              <Package size={14} /> Pedido: {pedidos[0].numeroPedidoCliente || pedidos[0].pedidoId}
            </span>
          </div>
        )}
        {pedidos.length > 1 && (
          <div className="mt-3 space-y-1.5" data-testid={`order-grouped-pedidos-${order.id}`}>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Layers size={14} /> {pedidos.length} pedidos agrupados:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {pedidos.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 font-data text-[11px] font-medium text-secondary-foreground" title={`${formatMeters(p.metros)} m vinculados`}>
                  {p.numeroPedidoCliente || p.pedidoId} <span className="text-muted-foreground">({formatMeters(p.metros)} m)</span>
                  {canManage && !blocked && onDeletePedido && (
                    <button
                      type="button"
                      onClick={() => onDeletePedido(p.id)}
                      disabled={deletingPedidoId === p.id}
                      className="pressable ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={`Quitar pedido ${p.numeroPedidoCliente || p.pedidoId} de la orden`}
                      title="Quitar pedido de la orden"
                      data-testid={`button-delete-order-pedido-${p.id}`}
                    >
                      <X size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
        {pedidos.length === 0 && order.origen === 'MANUAL' && (
          <div className="mt-3">
            <span className="rounded bg-muted px-2 py-0.5 font-data text-[10px] font-medium text-muted-foreground">Orden manual</span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 border-y border-border py-4 xl:min-w-0 xl:border-y-0 xl:border-l xl:py-0 xl:pl-7"><div><p className="text-[11px] text-muted-foreground">Necesarios</p><p className="mt-1 font-data text-xl font-semibold">{formatMeters(order.metrosNecesarios)} <span className="text-xs font-normal text-muted-foreground">m</span></p></div><div><p className="text-[11px] text-muted-foreground">Fabricados</p><p className="mt-1 font-data text-xl font-semibold text-primary">{formatMeters(order.metrosFabricados)} <span className="text-xs font-normal text-muted-foreground">m</span></p></div><div><p className="text-[11px] text-muted-foreground">Pendientes</p><p className="mt-1 font-data text-xl font-semibold text-accent-foreground">{formatMeters(order.metrosPendientes)} <span className="text-xs font-normal text-muted-foreground">m</span></p></div></div>
      <div className="xl:w-auto"><div className="flex justify-between text-[11px] text-muted-foreground"><span>Avance</span><span className="font-data font-semibold text-foreground">{Math.round(progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-[11px] text-muted-foreground">Creada {formatDate(order.creadoEn)}</p>{blocked && <p className="mt-3 text-[11px] font-medium text-[#906000]">Producción detenida</p>}</div>
      {canManage && <div className="flex flex-wrap gap-2 xl:flex-col xl:items-stretch"><div className="flex gap-2"><button type="button" onClick={onMoveUp} disabled={actionPending || !canMoveUp} className="pressable flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg border border-border px-2 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" aria-label="Subir prioridad" data-testid={`button-move-order-up-${order.id}`}><ChevronUp size={16} /> Subir</button><button type="button" onClick={onMoveDown} disabled={actionPending || !canMoveDown} className="pressable flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg border border-border px-2 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" aria-label="Bajar prioridad" data-testid={`button-move-order-down-${order.id}`}><ChevronDown size={16} /> Bajar</button></div>{canPosition && <button type="button" onClick={onPosition} disabled={actionPending} className="pressable flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-border px-2 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" title="Mover a una posición concreta" data-testid={`button-position-order-${order.id}`}><ArrowDownUp size={16} /> Posición {index + 1}</button>}{blocked ? <>
        <button type="button" onClick={onUnblock} disabled={actionPending} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-primary/25 px-3 text-xs font-semibold text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-unblock-order-${order.id}`}><Unlock size={16} /> Desbloquear</button>
        <button type="button" onClick={onFinalize} disabled={actionPending} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 text-xs font-semibold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-finalize-order-${order.id}`} title="Finalizar orden manualmente"><CheckCircle2 size={16} /> Finalizar manual</button>
      </> : <button type="button" onClick={onBlock} disabled={actionPending} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-accent/60 bg-secondary/70 px-3 text-xs font-semibold text-accent-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-block-order-${order.id}`}><Lock size={16} /> Bloquear</button>}{!blocked && <><button type="button" onClick={onEdit} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-primary/25 px-3 text-xs font-semibold text-primary hover:bg-muted" data-testid={`button-edit-order-${order.id}`}>Editar</button><button type="button" onClick={onDelete} className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-destructive/25 px-3 text-xs font-semibold text-destructive hover:bg-destructive/5" data-testid={`button-delete-order-${order.id}`}><Trash2 size={16} /> Eliminar</button></>}</div>}
    </div>
  </article>;
}

export default Production;
