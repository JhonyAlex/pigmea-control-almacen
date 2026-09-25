import { type FormEvent, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Check, CirclePlus, Factory, Layers3, Package, PackageCheck, RefreshCw, RotateCcw, Send, TriangleAlert, ChevronDown, X } from 'lucide-react';
import {
  CoilStatus,
  CoilTipo,
  getListInventoryQueryKey,
  getListOrdersQueryKey,
  OrderStatus,
  useAddManufacturedCoil,
  useAddProductionRemnant,
  useConsumeInventoryItem,
  useListInventory,
  useListOrders,
  useRestoreInventoryItem,
  type Coil,
} from '@workspace/api-client-react';
import { Field, inputClass, Modal } from '@/components/modal';
import { CoilCamisaEditor, CoilMaterialEditor, CoilMetersEditor } from '@/components/coil-material-editor';
import { MaterialChip } from '@/components/material-chip';
import { OrderPicker } from '@/components/order-picker';
import {
  CAMISAS,
  characteristicsLabel,
  formatDate,
  formatMeters,
  formatOrdenLabel,
  formatPedidosSummary,
  groupInventory,
  INVENTORY_SORT_FIELDS,
  readInventorySortPreference,
  saveInventorySortPreference,
  sortFactoryCoils,
  sortInventoryGroups,
  toggleInventorySort,
  type InventorySortField,
  type InventorySortState,
} from '@/lib/domain';

const SORT_FIELD_LABELS: Record<InventorySortField, string> = {
  ancho: 'Ancho',
  micras: 'Micras',
  camisa: 'Camisa',
  material: 'Material',
  metros: 'Metros',
};

const MATERIALES_BASE = ['OPP', 'OPP RECICLADO'];

function LoadingState() {
  return <div className="space-y-3" aria-label="Cargando inventario" data-testid="loading-inventory"><div className="h-24 animate-pulse rounded-xl bg-muted" /><div className="grid gap-3 sm:grid-cols-2"><div className="h-36 animate-pulse rounded-xl bg-muted" /><div className="h-36 animate-pulse rounded-xl bg-muted" /></div></div>;
}

function QueryError({ onRetry }: { onRetry: () => void }) {
  return <div className="flex flex-col items-start gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-6" role="alert" data-testid="error-inventory"><div className="flex items-center gap-3 text-destructive"><TriangleAlert size={21} /><p className="font-semibold">No se pudo cargar el almacén</p></div><p className="text-sm text-muted-foreground">Comprueba la conexión y vuelve a intentarlo.</p><button type="button" onClick={onRetry} className="pressable flex min-h-11 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground" data-testid="button-retry-inventory"><RefreshCw size={16} /> Reintentar</button></div>;
}

function Home({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const inventoryQuery = useListInventory({ status: CoilStatus.DISPONIBLE });
  const factoryQuery = useListInventory({ status: CoilStatus.EN_FÁBRICA });
  const ordersQuery = useListOrders({ status: OrderStatus.BLOQUEADA });
  const allOrdersQuery = useListOrders();
  const addManufactured = useAddManufacturedCoil();
  const addRemnant = useAddProductionRemnant();
  const consume = useConsumeInventoryItem();
  const restore = useRestoreInventoryItem();
  const [modal, setModal] = useState<'manufactured' | 'remnant' | null>(null);
  const [pendingConsume, setPendingConsume] = useState<Coil | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sort, setSort] = useState<InventorySortState | null>(readInventorySortPreference);
  const [manufacturedOrderId, setManufacturedOrderId] = useState<number | null>(null);

  const [remnantAncho, setRemnantAncho] = useState<string>('');
  const [remnantMicras, setRemnantMicras] = useState<string>('');
  const [remnantCamisa, setRemnantCamisa] = useState<string>('');
  const [remnantMaterial, setRemnantMaterial] = useState<string>('');

  const items = inventoryQuery.data?.items ?? [];
  const groups = useMemo(
    () => sortInventoryGroups(groupInventory(items), sort),
    [items, sort],
  );
  const activeOrders = ordersQuery.data ?? [];
  const allOrders = allOrdersQuery.data ?? [];
  const factoryCoils = useMemo(
    () => sortFactoryCoils(factoryQuery.data?.items ?? []),
    [factoryQuery.data?.items],
  );

  // Suggestions for the coil material editor: every material already known
  // (orders + current stock + factory) plus the default catalog. Free text is
  // still allowed by the datalist.
  const knownMaterials = useMemo(() => {
    const set = new Set<string>(MATERIALES_BASE);
    for (const order of allOrders) set.add(order.material);
    for (const item of items) set.add(item.material);
    for (const item of factoryCoils) set.add(item.material);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  }, [allOrders, items, factoryCoils]);

  // Suggestions for the coil camisa editor: catalog CAMISAS + all orders + current stock + factory.
  // Free text/numbers are still allowed by the datalist without restriction.
  const knownCamisas = useMemo(() => {
    const set = new Set<string>();
    for (const c of CAMISAS) set.add(String(c));
    for (const order of allOrders) if (order.camisa) set.add(String(order.camisa));
    for (const item of items) if (item.camisa) set.add(String(item.camisa));
    for (const item of factoryCoils) if (item.camisa) set.add(String(item.camisa));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }));
  }, [allOrders, items, factoryCoils]);

  const orderSpecs = useMemo(() => {
    const specs: Array<{ ancho: number; micras: number; camisa: string; material: string }> = [];
    const seen = new Set<string>();
    for (const order of allOrders) {
      const key = `${order.ancho}__${order.micras}__${order.camisa}__${order.material}`;
      if (!seen.has(key)) {
        seen.add(key);
        specs.push({
          ancho: order.ancho,
          micras: order.micras,
          camisa: String(order.camisa),
          material: order.material,
        });
      }
    }
    return specs;
  }, [allOrders]);

  const availableAnchos = useMemo(() => {
    const set = new Set<number>();
    for (const s of orderSpecs) {
      set.add(s.ancho);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [orderSpecs]);

  const availableMicras = useMemo(() => {
    if (!remnantAncho) return [];
    const set = new Set<number>();
    for (const s of orderSpecs) {
      if (String(s.ancho) === remnantAncho) {
        set.add(s.micras);
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [orderSpecs, remnantAncho]);

  const availableCamisas = useMemo(() => {
    if (!remnantAncho || !remnantMicras) return [];
    const set = new Set<string>();
    for (const s of orderSpecs) {
      if (String(s.ancho) === remnantAncho && String(s.micras) === remnantMicras) {
        set.add(s.camisa);
      }
    }
    return Array.from(set).sort();
  }, [orderSpecs, remnantAncho, remnantMicras]);

  const availableMaterials = useMemo(() => {
    if (!remnantAncho || !remnantMicras || !remnantCamisa) return [];
    const set = new Set<string>();
    for (const s of orderSpecs) {
      if (
        String(s.ancho) === remnantAncho &&
        String(s.micras) === remnantMicras &&
        s.camisa === remnantCamisa
      ) {
        set.add(s.material);
      }
    }
    return Array.from(set).sort();
  }, [orderSpecs, remnantAncho, remnantMicras, remnantCamisa]);

  const handleAnchoChange = (newAncho: string) => {
    setRemnantAncho(newAncho);
    if (!newAncho) {
      setRemnantMicras('');
      setRemnantCamisa('');
      setRemnantMaterial('');
      return;
    }

    const nextMicras = Array.from(
      new Set(orderSpecs.filter((s) => String(s.ancho) === newAncho).map((s) => s.micras)),
    ).sort((a, b) => a - b);

    if (nextMicras.length === 1) {
      const singleMicras = String(nextMicras[0]);
      setRemnantMicras(singleMicras);

      const nextCamisas = Array.from(
        new Set(
          orderSpecs
            .filter((s) => String(s.ancho) === newAncho && String(s.micras) === singleMicras)
            .map((s) => s.camisa),
        ),
      ).sort();

      if (nextCamisas.length === 1) {
        const singleCamisa = nextCamisas[0];
        setRemnantCamisa(singleCamisa);

        const nextMaterials = Array.from(
          new Set(
            orderSpecs
              .filter(
                (s) =>
                  String(s.ancho) === newAncho &&
                  String(s.micras) === singleMicras &&
                  s.camisa === singleCamisa,
              )
              .map((s) => s.material),
          ),
        ).sort();

        if (nextMaterials.length === 1) {
          setRemnantMaterial(nextMaterials[0]);
        } else if (nextMaterials.includes(remnantMaterial)) {
          // Keep
        } else {
          setRemnantMaterial('');
        }
      } else if (nextCamisas.includes(remnantCamisa)) {
        const nextMaterials = Array.from(
          new Set(
            orderSpecs
              .filter(
                (s) =>
                  String(s.ancho) === newAncho &&
                  String(s.micras) === singleMicras &&
                  s.camisa === remnantCamisa,
              )
              .map((s) => s.material),
          ),
        ).sort();
        if (nextMaterials.length === 1) {
          setRemnantMaterial(nextMaterials[0]);
        } else if (!nextMaterials.includes(remnantMaterial)) {
          setRemnantMaterial('');
        }
      } else {
        setRemnantCamisa('');
        setRemnantMaterial('');
      }
    } else if (nextMicras.map(String).includes(remnantMicras)) {
      const nextCamisas = Array.from(
        new Set(
          orderSpecs
            .filter((s) => String(s.ancho) === newAncho && String(s.micras) === remnantMicras)
            .map((s) => s.camisa),
        ),
      ).sort();
      if (nextCamisas.length === 1) {
        setRemnantCamisa(nextCamisas[0]);
        const nextMaterials = Array.from(
          new Set(
            orderSpecs
              .filter(
                (s) =>
                  String(s.ancho) === newAncho &&
                  String(s.micras) === remnantMicras &&
                  s.camisa === nextCamisas[0],
              )
              .map((s) => s.material),
          ),
        ).sort();
        if (nextMaterials.length === 1) {
          setRemnantMaterial(nextMaterials[0]);
        } else if (!nextMaterials.includes(remnantMaterial)) {
          setRemnantMaterial('');
        }
      } else if (!nextCamisas.includes(remnantCamisa)) {
        setRemnantCamisa('');
        setRemnantMaterial('');
      }
    } else {
      setRemnantMicras('');
      setRemnantCamisa('');
      setRemnantMaterial('');
    }
  };

  const handleMicrasChange = (newMicras: string) => {
    setRemnantMicras(newMicras);
    if (!newMicras) {
      setRemnantCamisa('');
      setRemnantMaterial('');
      return;
    }

    const nextCamisas = Array.from(
      new Set(
        orderSpecs
          .filter((s) => String(s.ancho) === remnantAncho && String(s.micras) === newMicras)
          .map((s) => s.camisa),
      ),
    ).sort();

    if (nextCamisas.length === 1) {
      const singleCamisa = nextCamisas[0];
      setRemnantCamisa(singleCamisa);

      const nextMaterials = Array.from(
        new Set(
          orderSpecs
            .filter(
              (s) =>
                String(s.ancho) === remnantAncho &&
                String(s.micras) === newMicras &&
                s.camisa === singleCamisa,
            )
            .map((s) => s.material),
        ),
      ).sort();

      if (nextMaterials.length === 1) {
        setRemnantMaterial(nextMaterials[0]);
      } else if (nextMaterials.includes(remnantMaterial)) {
        // Keep
      } else {
        setRemnantMaterial('');
      }
    } else if (nextCamisas.includes(remnantCamisa)) {
      const nextMaterials = Array.from(
        new Set(
          orderSpecs
            .filter(
              (s) =>
                String(s.ancho) === remnantAncho &&
                String(s.micras) === newMicras &&
                s.camisa === remnantCamisa,
            )
            .map((s) => s.material),
        ),
      ).sort();
      if (nextMaterials.length === 1) {
        setRemnantMaterial(nextMaterials[0]);
      } else if (!nextMaterials.includes(remnantMaterial)) {
        setRemnantMaterial('');
      }
    } else {
      setRemnantCamisa('');
      setRemnantMaterial('');
    }
  };

  const handleCamisaChange = (newCamisa: string) => {
    setRemnantCamisa(newCamisa);
    if (!newCamisa) {
      setRemnantMaterial('');
      return;
    }

    const nextMaterials = Array.from(
      new Set(
        orderSpecs
          .filter(
            (s) =>
              String(s.ancho) === remnantAncho &&
              String(s.micras) === remnantMicras &&
              s.camisa === newCamisa,
          )
          .map((s) => s.material),
      ),
    ).sort();

    if (nextMaterials.length === 1) {
      setRemnantMaterial(nextMaterials[0]);
    } else if (!nextMaterials.includes(remnantMaterial)) {
      setRemnantMaterial('');
    }
  };

  const openRemnantModal = () => {
    setNotice(null);
    setRemnantAncho('');
    setRemnantMicras('');
    setRemnantCamisa('');
    setRemnantMaterial('');
    void allOrdersQuery.refetch();
    setModal('remnant');
  };

  const closeRemnantModal = () => {
    setModal(null);
    setRemnantAncho('');
    setRemnantMicras('');
    setRemnantCamisa('');
    setRemnantMaterial('');
  };

  const refreshInventory = () => {
    inventoryQuery.refetch();
    factoryQuery.refetch();
  };

  const handleSort = (field: InventorySortField) => {
    setSort((current) => {
      const next = toggleInventorySort(current, field);
      saveInventorySortPreference(next);
      return next;
    });
  };

  const clearSort = () => {
    setSort(null);
    saveInventorySortPreference(null);
  };
  const invalidateInventory = () => {
    queryClient.invalidateQueries({ queryKey: getListInventoryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey({ status: OrderStatus.BLOQUEADA }) });
    queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
  };

  const handleRestore = (id: number) => {
    restore.mutate({ id }, {
      onSuccess: () => {
        invalidateInventory();
        setNotice('Bobina devuelta a la orden y restablecida en el almacén.');
      },
      onError: () => {
        setNotice('No se pudo devolver la bobina. Inténtalo de nuevo.');
      },
    });
  };

  const handleManufactured = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const metros = Number(form.get('metros'));
    if (metros < 100 || metros > 25000 || manufacturedOrderId === null) return;
    addManufactured.mutate({ data: { ordenId: manufacturedOrderId, metros } }, {
      onSuccess: () => { invalidateInventory(); setModal(null); setNotice('Bobina fabricada incorporada al almacén.'); },
    });
  };

  const handleRemnant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const metros = Number(form.get('metros'));
    const ancho = Number(form.get('ancho'));
    const micras = Number(form.get('micras'));
    const camisa = String(form.get('camisa') ?? '').trim();
    const material = String(form.get('material') ?? '').trim();
    if (!Number.isFinite(metros) || !Number.isFinite(ancho) || !Number.isFinite(micras) || !camisa || !material) return;
    addRemnant.mutate({
      data: {
        metros,
        ancho,
        micras,
        camisa,
        material,
      },
    }, {
      onSuccess: () => {
        invalidateInventory();
        closeRemnantModal();
        setNotice('Resto añadido al almacén.');
      },
    });
  };

  const handleConsume = () => {
    if (!pendingConsume) return;
    consume.mutate({ id: pendingConsume.id }, {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListInventoryQueryKey() }); setPendingConsume(null); setNotice('Material enviado a fábrica.'); },
    });
  };

  return (
    <div className="industrial-grid min-h-[calc(100dvh-72px)]">
      <div className="mx-auto max-w-[1480px] px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
        <div className="load-in mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="font-data text-[10px] font-semibold uppercase tracking-[.2em] text-primary">Módulo 01 / almacén</p>
            <h1 className="mt-2 font-display text-[clamp(2.7rem,6vw,4.7rem)] font-semibold uppercase leading-[.88] tracking-wide text-foreground">Estado de stock</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">Material disponible para expedición a fábrica.{canManage ? ' Registra entradas y mueve bobinas con una sola acción.' : ' Registra entradas y envía material a fábrica.'}</p>
          </div>
          <div className="flex gap-2.5">
            <button type="button" onClick={openRemnantModal} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg border border-primary/25 bg-card px-4 text-sm font-semibold text-primary hover:bg-muted sm:px-5" data-testid="button-add-remnant"><CirclePlus size={18} /> Añadir resto</button>
            <button type="button" onClick={() => { setNotice(null); setManufacturedOrderId(null); setModal('manufactured'); }} className="pressable flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:brightness-110 sm:px-5" data-testid="button-add-manufactured"><Factory size={18} /> Bobina fabricada</button>
          </div>
        </div>

        {notice && <div className="mb-6 flex items-center gap-3 rounded-lg border border-[#a9c9b1] bg-[#eaf4eb] px-4 py-3 text-sm font-medium text-[#27613d]" role="status" data-testid="status-inventory-success"><Check size={18} /> {notice}<button type="button" className="ml-auto text-xs uppercase tracking-wider underline" onClick={() => setNotice(null)} data-testid="button-dismiss-notice">Cerrar</button></div>}
        {(inventoryQuery.isLoading || ordersQuery.isLoading || factoryQuery.isLoading) && <LoadingState />}
        {(inventoryQuery.isError || factoryQuery.isError) && !inventoryQuery.isLoading && <QueryError onRetry={refreshInventory} />}
        {!inventoryQuery.isLoading && !inventoryQuery.isError && (
          <>
            <section className="load-in-delay">
              <div className="relative overflow-hidden rounded-xl bg-primary p-6 text-primary-foreground shadow-lg sm:p-8">
                <div className="absolute right-[-28px] top-[-42px] h-48 w-48 rounded-full border-[22px] border-primary-foreground/10" />
                <div className="absolute bottom-[-80px] right-[90px] h-56 w-56 rounded-full border-[1px] border-primary-foreground/10" />
                <div className="relative">
                  <div className="flex items-center justify-between"><p className="font-data text-[10px] font-semibold uppercase tracking-[.2em] text-primary-foreground/65">Total en almacén</p><Layers3 size={21} className="text-accent" /></div>
                  <div className="mt-6 flex items-end gap-3"><span className="font-display text-[clamp(4rem,10vw,7.8rem)] font-semibold leading-[.72] tracking-tight" data-testid="text-total-meters">{formatMeters(inventoryQuery.data?.totalMetros ?? 0)}</span><span className="mb-1.5 font-display text-3xl uppercase text-primary-foreground/70">metros</span></div>
                  <div className="mt-8 flex items-center gap-2 border-t border-primary-foreground/15 pt-4 text-xs text-primary-foreground/70"><PackageCheck size={16} /> {items.length} unidades registradas <span className="ml-auto font-data text-[10px] uppercase tracking-wider">Actualizado ahora</span></div>
                </div>
              </div>
            </section>

            <section className="mt-10">
              <div className="mb-4 flex items-end justify-between"><div><p className="font-data text-[10px] font-semibold uppercase tracking-[.2em] text-muted-foreground">Agrupación por características</p><h2 className="mt-1 font-display text-3xl font-semibold uppercase tracking-wide">Bobinas en almacén</h2></div><span className="hidden font-data text-[10px] uppercase tracking-wider text-muted-foreground sm:block">Ancho / micras / camisa / material</span></div>
              {groups.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="inventory-sort-bar">
                  <span className="mr-1 font-data text-[10px] font-semibold uppercase tracking-[.15em] text-muted-foreground">Ordenar por</span>
                  {INVENTORY_SORT_FIELDS.map((field) => {
                    const active = sort?.field === field;
                    const direction = active ? sort?.direction : undefined;
                    const DirectionIcon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown;
                    return (
                      <button
                        key={field}
                        type="button"
                        onClick={() => handleSort(field)}
                        aria-pressed={active}
                        title={active ? `Ordenando por ${SORT_FIELD_LABELS[field]} (${direction === 'asc' ? 'ascendente' : 'descendente'})` : `Ordenar por ${SORT_FIELD_LABELS[field]}`}
                        className={`pressable flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                        data-testid={`button-sort-${field}`}
                      >
                        {SORT_FIELD_LABELS[field]}
                        <DirectionIcon size={13} className={active ? '' : 'opacity-50'} />
                      </button>
                    );
                  })}
                  {sort && (
                    <button
                      type="button"
                      onClick={clearSort}
                      className="pressable flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      title="Volver al orden por metros totales"
                      data-testid="button-clear-sort"
                    >
                      <X size={12} /> Quitar orden
                    </button>
                  )}
                </div>
              )}
              {groups.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-card/60 px-6 py-14 text-center" data-testid="empty-inventory"><PackageCheck className="mx-auto text-muted-foreground" size={30} /><h3 className="mt-3 font-display text-2xl uppercase">Almacén vacío</h3><p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Añade una bobina fabricada o registra un resto para empezar.</p></div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {groups.map((group) => (
                    <details key={`${group.ancho}-${group.micras}-${group.camisa}-${group.material}`} className="group rounded-xl border border-border bg-card transition open:border-primary/40" data-testid={`card-inventory-group-${group.id}`}>
                      <summary className="flex min-h-[128px] cursor-pointer list-none items-center justify-between gap-4 p-5 [&::-webkit-details-marker]:hidden">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <MaterialChip material={group.material} size="lg" testId={`text-group-material-${group.id}`} />
                            <span className="font-display text-[1.55rem] font-semibold uppercase leading-none tracking-wide text-foreground" data-testid={`text-group-camisa-${group.id}`}>Camisa {group.camisa}</span>
                          </div>
                          <h3 className="mt-2.5 font-display text-[1.9rem] font-semibold leading-none">{group.ancho} <span className="text-base font-medium text-muted-foreground">mm</span><span className="mx-2 text-muted-foreground/40">·</span>{group.micras} <span className="text-base font-medium text-muted-foreground">µ</span></h3>
                          <p className="mt-2 text-xs text-muted-foreground">{group.count} {group.count === 1 ? 'unidad' : 'unidades'} · {formatMeters(group.total)} m</p>
                        </div>
                        <ChevronDown size={22} className="shrink-0 text-muted-foreground transition group-open:rotate-180" />
                      </summary>
                      <div className="border-t border-border px-5 pb-4">
                        {group.items.map((item) => {
                          const itemPedidos = item.pedidosRelacionados ?? [];
                          const isAssignedElsewhere = !!item.asignacion && item.asignacion.ordenId !== item.ordenId;
                          return (
                            <div key={item.id} className="flex flex-col gap-3 border-b border-border py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold">
                                    {item.tipo === CoilTipo.RESTO ? 'RESTO' : 'Bobina'}
                                  </span>
                                  <CoilMetersEditor coil={item} canManage={canManage} onSaved={setNotice} />
                                  {item.ordenId && (
                                    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-data text-[10px] font-semibold text-primary" title={isAssignedElsewhere ? 'Orden de origen de la bobina' : undefined}>
                                      {isAssignedElsewhere ? 'Origen ' : ''}{formatOrdenLabel(item.ordenId)}
                                    </span>
                                  )}
                                  {isAssignedElsewhere && (
                                    <span className="rounded bg-accent/20 px-1.5 py-0.5 font-data text-[10px] font-semibold text-accent-foreground" title="Resto de stock (Añadir Resto) asignado automáticamente a esta orden" data-testid={`badge-assigned-${item.id}`}>
                                      Resto asignado a {formatOrdenLabel(item.asignacion!.ordenId)}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                  <CoilMaterialEditor coil={item} materials={knownMaterials} canManage={canManage} onSaved={setNotice} />
                                  <CoilCamisaEditor coil={item} camisas={knownCamisas} canManage={canManage} onSaved={setNotice} />
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">Entrada {new Date(item.creadoEn).toLocaleDateString('es-ES')}</p>
                                {itemPedidos.length > 0 ? (
                                  <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-primary">
                                    <Package size={13} className="shrink-0" />
                                    {formatPedidosSummary(itemPedidos)}
                                  </p>
                                ) : (
                                  <p className="mt-0.5 font-data text-[10px] text-muted-foreground">Sin pedido asociado</p>
                                )}
                              </div>
                              <button type="button" onClick={() => setPendingConsume(item)} className="pressable flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground" data-testid={`button-group-consume-${item.id}`}><Send size={15} /> Enviar a fábrica</button>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </section>

            <section className="mt-10 pb-5">
              <div className="mb-4 flex items-end justify-between">
                <div>
                  <p className="font-data text-[10px] font-semibold uppercase tracking-[.2em] text-primary">Fábrica / En planta</p>
                  <h2 className="mt-1 font-display text-3xl font-semibold uppercase tracking-wide">Bobinas movidas a fábrica</h2>
                </div>
                <span className="font-data text-[10px] uppercase tracking-wider text-muted-foreground">
                  {factoryCoils.length} {factoryCoils.length === 1 ? 'bobina' : 'bobinas'}
                </span>
              </div>
              {factoryCoils.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-card/60 px-6 py-10 text-center text-sm text-muted-foreground" data-testid="empty-factory-coils">
                  No hay bobinas movidas a fábrica actualmente.
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <div className="hidden gap-4 border-b border-border bg-muted/55 px-5 py-3 font-data text-[10px] font-semibold uppercase tracking-[.13em] text-muted-foreground md:grid md:grid-cols-[1.4fr_.65fr_.7fr_.6fr_180px]">
                    <span>Identificación / Pedido</span>
                    <span>Tipo</span>
                    <span>Metros</span>
                    <span>Estado</span>
                    <span className="text-right">Acción</span>
                  </div>
                  {factoryCoils.map((item) => {
                    const itemPedidos = item.pedidosRelacionados ?? [];
                    const isRestoring = restore.isPending && restore.variables?.id === item.id;
                    return (
                      <div
                        key={item.id}
                        className="grid gap-3 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.4fr_.65fr_.7fr_.6fr_180px] md:items-center md:gap-4 md:px-5"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-foreground" data-testid={`text-factory-item-${item.id}`}>
                              {item.ancho} mm · {item.micras} µ
                            </p>
                            {item.ordenId && (
                              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-data text-[10px] font-semibold text-primary">
                                ORD-{String(item.ordenId).padStart(4, '0')}
                              </span>
                            )}
                            {item.asignacion && item.asignacion.ordenId !== item.ordenId && (
                              <span className="rounded bg-accent/20 px-1.5 py-0.5 font-data text-[10px] font-semibold text-accent-foreground" title="Resto de stock (Añadir Resto) asignado automáticamente a esta orden">
                                Resto asignado a {formatOrdenLabel(item.asignacion.ordenId)}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            Camisa {item.camisa} · <MaterialChip material={item.material} size="sm" />
                          </p>
                          {itemPedidos.length > 0 ? (
                            <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-primary">
                              <Package size={13} className="shrink-0" />
                              {formatPedidosSummary(itemPedidos)}
                            </p>
                          ) : (
                            <p className="mt-0.5 font-data text-[10px] text-muted-foreground">Sin pedido asociado</p>
                          )}
                        </div>
                        <span className="w-fit rounded-md bg-muted px-2 py-1 font-data text-[10px] font-semibold">
                          {item.tipo}
                        </span>
                        <p className="font-data text-lg font-semibold">
                          {formatMeters(item.metros)} <span className="text-xs font-normal text-muted-foreground">m</span>
                        </p>
                        <div>
                          <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                            {item.estado}
                          </span>
                          {item.movidoAFabricaEn && (
                            <p className="mt-0.5 font-data text-[10px] text-muted-foreground" title="Fecha y hora de envío a fábrica">
                              {formatDate(item.movidoAFabricaEn)}
                            </p>
                          )}
                        </div>
                        <div className="flex md:justify-end">
                          <button
                            type="button"
                            onClick={() => handleRestore(item.id)}
                            disabled={isRestoring}
                            className="pressable flex min-h-11 items-center justify-center gap-2 rounded-lg border border-primary/25 px-3 text-xs font-semibold text-primary hover:bg-muted disabled:opacity-50"
                            data-testid={`button-restore-coil-${item.id}`}
                          >
                            <RotateCcw size={15} className={isRestoring ? 'animate-spin' : ''} />
                            {isRestoring ? 'Devolviendo…' : 'Devolver a la orden'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <Modal open={modal === 'manufactured'} onClose={() => setModal(null)} onSubmit={handleManufactured} eyebrow="Entrada de almacén" title="Bobina fabricada" submitLabel={addManufactured.isPending ? 'Registrando…' : 'Registrar bobina'} submitDisabled={addManufactured.isPending || activeOrders.length === 0 || manufacturedOrderId === null}>
        {addManufactured.isError && <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="error-add-manufactured">No se pudo registrar la bobina. Revisa los datos.</p>}
        {activeOrders.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center"><AlertTriangle className="mx-auto text-accent" size={25} /><p className="mt-2 text-sm font-medium">No hay órdenes bloqueadas</p><p className="mt-1 text-xs text-muted-foreground">No hay órdenes bloqueadas disponibles para registrar fabricación.</p></div> : <div className="space-y-5"><OrderPicker orders={activeOrders} value={manufacturedOrderId} onChange={setManufacturedOrderId} /><Field label="Metros fabricados" hint="mín. 100, máx. 25.000"><input name="metros" type="number" min="100" max="25000" step="1" required className={inputClass} placeholder="Ej. 1.250" data-testid="input-manufactured-meters" /></Field></div>}
      </Modal>

      <Modal
        open={modal === 'remnant'}
        onClose={closeRemnantModal}
        onSubmit={handleRemnant}
        eyebrow="Entrada de almacén"
        title="Añadir resto"
        submitLabel={addRemnant.isPending ? 'Guardando…' : 'Guardar resto'}
        submitDisabled={addRemnant.isPending}
      >
        {addRemnant.isError && (
          <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="error-add-remnant">
            No se pudo guardar el resto. Revisa los datos.
          </p>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Ancho" hint="mm">
              <input
                name="ancho"
                type="number"
                step="any"
                required
                className={inputClass}
                list="remnant-width-options"
                placeholder="Ej. 1.200"
                data-testid="select-remnant-width"
              />
              <datalist id="remnant-width-options">
                {availableAnchos.map((ancho) => (
                  <option key={ancho} value={ancho}>
                    {ancho} mm
                  </option>
                ))}
              </datalist>
            </Field>

            <Field label="Micras" hint="µ">
              <input
                name="micras"
                type="number"
                step="any"
                required
                className={inputClass}
                list="remnant-microns-options"
                placeholder="Ej. 30"
                data-testid="select-remnant-microns"
              />
              <datalist id="remnant-microns-options">
                {Array.from(new Set(orderSpecs.map((spec) => spec.micras))).sort((a, b) => a - b).map((micras) => (
                  <option key={micras} value={micras}>
                    {micras} µ
                  </option>
                ))}
              </datalist>
            </Field>

            <Field label="Camisa">
              <input
                name="camisa"
                required
                className={inputClass}
                list="remnant-sleeve-options"
                placeholder="Ej. 400"
                data-testid="select-remnant-sleeve"
              />
              <datalist id="remnant-sleeve-options">
                {Array.from(new Set(orderSpecs.map((spec) => spec.camisa))).sort().map((camisa) => (
                  <option key={camisa} value={camisa}>
                    {camisa}
                  </option>
                ))}
              </datalist>
            </Field>

            <Field label="Material">
              <input
                name="material"
                required
                className={inputClass}
                list="remnant-material-options"
                placeholder="Ej. OPP"
                data-testid="select-remnant-material"
              />
              <datalist id="remnant-material-options">
                {Array.from(new Set(orderSpecs.map((spec) => spec.material))).sort().map((material) => (
                  <option key={material} value={material}>
                    {material}
                  </option>
                ))}
              </datalist>
            </Field>

            <div className="sm:col-span-2">
              <Field label="Metros del resto">
                <input
                  name="metros"
                  type="number"
                  step="any"
                  required
                  className={inputClass}
                  placeholder="Ej. 840"
                  data-testid="input-remnant-meters"
                />
              </Field>
            </div>
        </div>
      </Modal>

      <Modal open={!!pendingConsume} onClose={() => setPendingConsume(null)} title="Enviar a fábrica" eyebrow="Confirmar movimiento" submitLabel={consume.isPending ? 'Moviendo…' : 'Confirmar envío'} submitDisabled={consume.isPending} destructive onSubmit={(event) => { event.preventDefault(); handleConsume(); }}>
          {pendingConsume && <div><div className="rounded-lg border border-border bg-muted/50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-data text-[10px] uppercase tracking-[.14em] text-muted-foreground">{pendingConsume.ordenId ? `Orden ORD-${String(pendingConsume.ordenId).padStart(4, '0')}` : 'Resto de almacén'}</p>{pendingConsume.pedidosRelacionados && pendingConsume.pedidosRelacionados.length > 0 && <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">{formatPedidosSummary(pendingConsume.pedidosRelacionados)}</span>}</div><p className="mt-2 font-semibold">{characteristicsLabel(pendingConsume)}</p><p className="mt-3 font-data text-3xl font-semibold">{formatMeters(pendingConsume.metros)} <span className="text-sm font-normal text-muted-foreground">metros</span></p></div><p className="mt-5 flex gap-2 text-sm leading-relaxed text-muted-foreground"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-accent" /> Esta acción marcará el material como <strong className="text-foreground">EN FÁBRICA</strong>. Comprueba la unidad antes de continuar.</p>{consume.isError && <p className="mt-4 text-sm text-destructive" role="alert" data-testid="error-consume">No se pudo mover la unidad. Inténtalo de nuevo.</p>}</div>}
      </Modal>
    </div>
  );
}

export default Home;
