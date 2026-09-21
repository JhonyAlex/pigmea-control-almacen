import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  AddManufacturedCoilBody,
  AddProductionRemnantBody,
  ConsumeInventoryItemParams,
  CreateOrderBody,
  SetOrderBlockedBody,
  SetOrderBlockedParams,
  UpdateCoilBody,
  UpdateCoilParams,
  UpdateCoilMaterialBody,
  UpdateCoilMaterialParams,
  UpdateOrderBody,
  UpdateOrderParams,
  DeleteOrderParams,
  FinalizeOrderBody,
  FinalizeOrderParams,
  ListInventoryQueryParams,
  ListOrderCoilsParams,
  ListOrderEventsParams,
  ListOrdersQueryParams,
  ReorderOrdersBody,
  ReopenOrderBody,
  ReopenOrderParams,
  RestoreInventoryItemParams,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  coils,
  productionOrderCoilAssignments,
  productionOrderEvents,
  productionOrders,
  productionOrderPedidos,
  users,
} from "@workspace/db/schema";
import { requireAdmin, requireAuth } from "../lib/auth";
import {
  getNexusGroupKey,
  normalizeCamisa,
  normalizeMaterialComparison,
} from "../lib/nexus-order-normalizer";
import {
  computeOrderCoveredMeters,
  type DbTransaction,
  getAssignmentsByCoilIds,
  toAssignmentInfo,
} from "../services/coil-stock-assignment";

const router: IRouter = Router();
router.use(requireAuth);
const CAMISAS = new Set([
  "400",
  "475",
  "520",
  "22-6-22",
  "21-8-21",
  "40-6-40",
  "40-8-40",
  "47-5-47",
  "47-8-47",
  "52-8-52",
]);
const MATERIALES = new Set(["OPP", "OPP RECICLADO"]);

const numeric = (value: string | number | null) => Number(value ?? 0);

// Numeric comparison under the same normalization the system stores with
// ("1200" and "1200.00" are the same width), so re-sending identical values
// in an equivalent format is never treated as a change.
const numbersEquivalent = (a: string | number, b: string | number) =>
  Math.abs(Number(a) - Number(b)) < 1e-6;

interface RelatedPedidoView {
  id: number;
  pedidoId: string;
  numeroPedidoCliente: string;
  metros: number;
  vinculadoEn: string;
}

const coilView = (
  coil: typeof coils.$inferSelect,
  pedidosRelacionados: RelatedPedidoView[] = [],
  asignacion: ReturnType<typeof toAssignmentInfo> | null = null,
) => ({
  id: coil.id,
  tipo: coil.tipo,
  metros: numeric(coil.metros),
  ancho: numeric(coil.ancho),
  micras: numeric(coil.micras),
  camisa: coil.camisa,
  material: coil.material,
  estado: coil.estado,
  ordenId: coil.ordenId,
  asignacion,
  pedidosRelacionados,
  creadoEn: coil.creadoEn.toISOString(),
  movidoAFabricaEn: coil.movidoAFabricaEn
    ? coil.movidoAFabricaEn.toISOString()
    : null,
});

/**
 * Builds the coil views for a set of coils, resolving the stock assignment of
 * each coil and the pedidos of the order each coil currently serves (the
 * assigned order when committed, otherwise its manufacturing order).
 */
async function buildCoilViews(
  items: Array<typeof coils.$inferSelect>,
  pedidosOverrideOrderId?: number,
): Promise<ReturnType<typeof coilView>[]> {
  const assignmentsMap = await getAssignmentsByCoilIds(
    db,
    items.map((item) => item.id),
  );
  const effectiveOrderIds = items.map(
    (item) => assignmentsMap.get(item.id)?.ordenId ?? item.ordenId,
  );
  const pedidosMap = pedidosOverrideOrderId
    ? await getPedidosByOrderIds([pedidosOverrideOrderId])
    : await getPedidosByOrderIds(
        effectiveOrderIds.filter((id): id is number => id !== null),
      );
  return items.map((item) => {
    const assignment = assignmentsMap.get(item.id);
    const effectiveOrderId =
      pedidosOverrideOrderId ??
      assignment?.ordenId ??
      item.ordenId ??
      undefined;
    return coilView(
      item,
      effectiveOrderId ? (pedidosMap.get(effectiveOrderId) ?? []) : [],
      assignment ? toAssignmentInfo(assignment) : null,
    );
  });
}

async function getPedidosByOrderIds(orderIds: number[]) {
  const validIds = Array.from(
    new Set(
      orderIds.filter(
        (id): id is number => typeof id === "number" && id > 0,
      ),
    ),
  );
  const map = new Map<number, RelatedPedidoView[]>();
  if (validIds.length === 0) return map;

  const records = await db
    .select()
    .from(productionOrderPedidos)
    .where(inArray(productionOrderPedidos.ordenId, validIds))
    .orderBy(
      asc(productionOrderPedidos.vinculadoEn),
      asc(productionOrderPedidos.id),
    );

  for (const item of records) {
    const list = map.get(item.ordenId) ?? [];
    list.push({
      id: item.id,
      pedidoId: item.pedidoId,
      numeroPedidoCliente: item.numeroPedidoCliente,
      metros: numeric(item.metros),
      vinculadoEn: item.vinculadoEn.toISOString(),
    });
    map.set(item.ordenId, list);
  }
  return map;
}

const orderView = (
  order: typeof productionOrders.$inferSelect,
  fabricados: number,
  pedidosRelacionados: RelatedPedidoView[] = [],
) => ({
  id: order.id,
  ancho: numeric(order.ancho),
  micras: numeric(order.micras),
  camisa: order.camisa,
  material: order.material,
  metrosNecesarios: numeric(order.metrosNecesarios),
  metrosFabricados: fabricados,
  metrosPendientes: Math.max(0, numeric(order.metrosNecesarios) - fabricados),
  estado:
    order.estado === "BLOQUEADA"
      ? "BLOQUEADA"
      : order.estado === "FINALIZADA" ||
          fabricados >= numeric(order.metrosNecesarios)
        ? "FINALIZADA"
        : "ACTIVA",
  origen: (order.origen ?? "MANUAL") as "MANUAL" | "GESTION_PEDIDOS",
  pedidosRelacionados,
  creadoEn: order.creadoEn.toISOString(),
  finalizadaEn: order.finalizadaEn?.toISOString() ?? null,
  nota: order.nota ?? null,
});

/**
 * Records a state-changing action on a production order for the audit
 * trail (who blocked/unblocked/finalized/reopened it, or that Nexus grouped
 * a pedido into it). `usuarioId` null means an automated process.
 */
async function logOrderEvent(
  tx: DbTransaction,
  event: {
    ordenId: number;
    usuarioId: number | null;
    accion: string;
    detalle?: string | null;
  },
) {
  await tx.insert(productionOrderEvents).values({
    ordenId: event.ordenId,
    usuarioId: event.usuarioId,
    accion: event.accion,
    detalle: event.detalle ?? null,
  });
}

async function ordersWithTotals(status?: string) {
  const orders = await db
    .select()
    .from(productionOrders)
    .orderBy(asc(productionOrders.orden), desc(productionOrders.id));

  // Covered meters per order: coils manufactured for the order that are not
  // committed elsewhere, plus pre-existing stock coils assigned to it.
  const directTotals = await db
    .select({
      ordenId: coils.ordenId,
      total: sql<string>`coalesce(sum(${coils.metros}), 0)`,
    })
    .from(coils)
    .where(
      sql`${coils.ordenId} is not null and not exists (
        select 1 from ${productionOrderCoilAssignments}
        where ${productionOrderCoilAssignments.coilId} = ${coils.id}
      )`,
    )
    .groupBy(coils.ordenId);
  const assignedTotals = await db
    .select({
      ordenId: productionOrderCoilAssignments.ordenId,
      total: sql<string>`coalesce(sum(${productionOrderCoilAssignments.metros}), 0)`,
    })
    .from(productionOrderCoilAssignments)
    .groupBy(productionOrderCoilAssignments.ordenId);
  const byOrder = new Map<number, number>();
  for (const row of directTotals) {
    if (row.ordenId !== null) byOrder.set(row.ordenId, numeric(row.total));
  }
  for (const row of assignedTotals) {
    byOrder.set(
      row.ordenId,
      (byOrder.get(row.ordenId) ?? 0) + numeric(row.total),
    );
  }

  // Batch query related pedidos to prevent N+1 queries
  const allRelated = await db
    .select()
    .from(productionOrderPedidos)
    .orderBy(
      asc(productionOrderPedidos.vinculadoEn),
      asc(productionOrderPedidos.id),
    );

  const byOrderPedidos = new Map<number, RelatedPedidoView[]>();
  for (const item of allRelated) {
    const list = byOrderPedidos.get(item.ordenId) ?? [];
    list.push({
      id: item.id,
      pedidoId: item.pedidoId,
      numeroPedidoCliente: item.numeroPedidoCliente,
      metros: numeric(item.metros),
      vinculadoEn: item.vinculadoEn.toISOString(),
    });
    byOrderPedidos.set(item.ordenId, list);
  }

  return orders
    .map((order) =>
      orderView(
        order,
        byOrder.get(order.id) ?? 0,
        byOrderPedidos.get(order.id) ?? [],
      ),
    )
    .filter((order) => !status || order.estado === status);
}

router.get("/orders", async (req, res, next) => {
  try {
    const query = ListOrdersQueryParams.parse(req.query);
    res.json(await ordersWithTotals(query.status));
  } catch (error) {
    next(error);
  }
});

router.post("/orders", requireAdmin, async (req, res, next) => {
  try {
    const body = CreateOrderBody.parse(req.body);
    if (!CAMISAS.has(String(body.camisa)) || !MATERIALES.has(body.material)) {
      res.status(400).json({ error: "Características no válidas" });
      return;
    }
    const { order, covered } = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(481929)`);
      const [created] = await tx
        .insert(productionOrders)
        .values({
          ancho: String(body.ancho),
          micras: String(body.micras),
          camisa: String(body.camisa),
          material: body.material,
          metrosNecesarios: String(body.metrosNecesarios),
          estado: "ACTIVA",
          origen: "MANUAL",
          orden: sql`coalesce((select min(${productionOrders.orden}) from ${productionOrders} where ${productionOrders.estado} = 'ACTIVA'), 0) - 1`,
        })
        .returning();
      const covered = await computeOrderCoveredMeters(tx, created.id);
      return { order: created, covered };
    });
    res.status(201).json(orderView(order, covered, []));
  } catch (error) {
    next(error);
  }
});

router.patch("/orders/reorder", requireAdmin, async (req, res, next) => {
  try {
    const { orderIds } = ReorderOrdersBody.parse(req.body);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(481929)`);
      const activeOrders = await tx
        .select({ id: productionOrders.id })
        .from(productionOrders)
        .where(eq(productionOrders.estado, "ACTIVA"));
      const activeIds = new Set(activeOrders.map((order) => order.id));
      const isExactOrder =
        orderIds.length === activeIds.size &&
        new Set(orderIds).size === orderIds.length &&
        orderIds.every((id) => activeIds.has(id));
      if (!isExactOrder) return false;

      await Promise.all(
        orderIds.map((id, index) =>
          tx
            .update(productionOrders)
            .set({ orden: index })
            .where(eq(productionOrders.id, id)),
        ),
      );
      return true;
    });
    if (!result) {
      res.status(409).json({ error: "La lista de órdenes cambió. Actualiza e inténtalo de nuevo." });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.delete("/orders/:id", requireAdmin, async (req, res, next) => {
  try {
    const { id } = DeleteOrderParams.parse({ id: Number(req.params.id) });
    const active = await ordersWithTotals("ACTIVA");
    if (!active.some((order) => order.id === id)) {
      res.status(404).json({ error: "La orden no está activa o no existe" });
      return;
    }
    await db.transaction(async (tx) => {
      // Keep already registered material in the warehouse when its order is
      // removed; only the relationship to the deleted order is cleared.
      await tx
        .update(coils)
        .set({ ordenId: null })
        .where(eq(coils.ordenId, id));
      await tx.delete(productionOrders).where(eq(productionOrders.id, id));
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.patch("/orders/:id", requireAdmin, async (req, res, next) => {
  try {
    const { id } = UpdateOrderParams.parse({ id: Number(req.params.id) });
    const body = UpdateOrderBody.parse(req.body);
    if (!CAMISAS.has(String(body.camisa)) || !MATERIALES.has(body.material)) {
      res.status(400).json({ error: "Características no válidas" });
      return;
    }
    // Everything below runs in a single transaction: the row lock is held
    // until commit, so a concurrent registration of material for this order
    // (Bobina fabricada, NEXUS, another edit) serializes before or after it.
    // There is no validate-then-write window in which new coverage could
    // invalidate the decision taken.
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(productionOrders)
        .where(eq(productionOrders.id, id))
        .for("update");
      if (!current) return { kind: "MISSING" as const };
      if (current.estado !== "ACTIVA") {
        return { kind: "NOT_ACTIVE" as const };
      }
      const covered = await computeOrderCoveredMeters(tx, id);

      // Once material is physically registered or assigned, the technical
      // characteristics are frozen; only meters may still be adjusted.
      const characteristicsChanged =
        !numbersEquivalent(current.ancho, body.ancho) ||
        !numbersEquivalent(current.micras, body.micras) ||
        normalizeCamisa(current.camisa) !== normalizeCamisa(body.camisa) ||
        normalizeMaterialComparison(current.material) !==
          normalizeMaterialComparison(body.material);
      if (covered > 0 && characteristicsChanged) {
        return { kind: "CHARACTERISTICS_LOCKED" as const };
      }
      if (covered > Number(body.metrosNecesarios)) {
        return { kind: "METERS_BELOW_COVERAGE" as const };
      }

      // Automatic orders keep the NEXUS invariant of one active order per
      // group: editing the characteristics must not land this order on a
      // group that already has another active automatic order, or the next
      // grouping request would find two candidates.
      if (current.origen === "GESTION_PEDIDOS" && characteristicsChanged) {
        const groupKey = getNexusGroupKey({
          ancho: Number(body.ancho),
          micras: Number(body.micras),
          material: body.material,
          camisa: String(body.camisa),
        });
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"nexus_group:" + groupKey}, 0))`,
        );

        const [duplicateActive] = await tx
          .select()
          .from(productionOrders)
          .where(
            and(
              eq(productionOrders.estado, "ACTIVA"),
              eq(productionOrders.origen, "GESTION_PEDIDOS"),
              sql`${productionOrders.id} != ${current.id}`,
              eq(productionOrders.ancho, Number(body.ancho).toFixed(2)),
              eq(productionOrders.micras, Number(body.micras).toFixed(2)),
              sql`lower(trim(${productionOrders.material})) = ${normalizeMaterialComparison(body.material)}`,
              sql`trim(${productionOrders.camisa}) = ${normalizeCamisa(String(body.camisa))}`,
            ),
          );

        if (duplicateActive) {
          return {
            kind: "DUPLICATE_ACTIVE_GROUP" as const,
            duplicateId: duplicateActive.id,
          };
        }
      }

      const [updatedOrder] = await tx
        .update(productionOrders)
        .set({
          ancho: String(body.ancho),
          micras: String(body.micras),
          camisa: String(body.camisa),
          material: body.material,
          metrosNecesarios: String(body.metrosNecesarios),
        })
        .where(eq(productionOrders.id, id))
        .returning();
      const related = await tx
        .select()
        .from(productionOrderPedidos)
        .where(eq(productionOrderPedidos.ordenId, id))
        .orderBy(asc(productionOrderPedidos.vinculadoEn));
      const coveredNow = await computeOrderCoveredMeters(tx, id);
      return {
        kind: "UPDATED" as const,
        order: updatedOrder,
        covered: coveredNow,
        pedidos: related.map((r) => ({
          id: r.id,
          pedidoId: r.pedidoId,
          numeroPedidoCliente: r.numeroPedidoCliente,
          metros: numeric(r.metros),
          vinculadoEn: r.vinculadoEn.toISOString(),
        })),
      };
    });

    if (result.kind === "MISSING") {
      res.status(404).json({ error: "La orden no existe" });
      return;
    }
    if (result.kind === "DUPLICATE_ACTIVE_GROUP") {
      res.status(409).json({
        error: `Ya existe una orden activa de Gestión Pedidos (ORD-${String(result.duplicateId).padStart(4, "0")}) con esas características`,
        code: "DUPLICATE_ACTIVE_GROUP",
      });
      return;
    }
    if (result.kind === "NOT_ACTIVE") {
      res.status(400).json({ error: "Solo se pueden editar órdenes activas" });
      return;
    }
    if (result.kind === "CHARACTERISTICS_LOCKED") {
      res.status(409).json({
        error:
          "No se pueden modificar las características de una orden que ya tiene material registrado o asignado.",
        code: "ORDER_CHARACTERISTICS_LOCKED",
      });
      return;
    }
    if (result.kind === "METERS_BELOW_COVERAGE") {
      res.status(400).json({
        error:
          "Los metros necesarios no pueden ser inferiores a los ya cubiertos",
      });
      return;
    }

    res.json(orderView(result.order, result.covered, result.pedidos));
  } catch (error) {
    next(error);
  }
});

router.patch("/orders/:id/blocked", requireAdmin, async (req, res, next) => {
  try {
    const { id } = SetOrderBlockedParams.parse({ id: Number(req.params.id) });
    const { blocked } = SetOrderBlockedBody.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(productionOrders)
        .where(eq(productionOrders.id, id))
        .for("update");
      if (!current) return { kind: "MISSING" as const };

      const total = await computeOrderCoveredMeters(tx, id);
      if (
        current.estado === "FINALIZADA" ||
        total >= numeric(current.metrosNecesarios)
      ) {
        return { kind: "FINALIZED" as const };
      }

      // Check if unblocking an automatic order would collide with an already active automatic order
      if (!blocked && current.origen === "GESTION_PEDIDOS") {
        const groupKey = getNexusGroupKey({
          ancho: Number(current.ancho),
          micras: Number(current.micras),
          material: current.material,
          camisa: current.camisa,
        });
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"nexus_group:" + groupKey}, 0))`,
        );

        const [duplicateActive] = await tx
          .select()
          .from(productionOrders)
          .where(
            and(
              eq(productionOrders.estado, "ACTIVA"),
              eq(productionOrders.origen, "GESTION_PEDIDOS"),
              sql`${productionOrders.id} != ${current.id}`,
              eq(productionOrders.ancho, current.ancho),
              eq(productionOrders.micras, current.micras),
              sql`lower(trim(${productionOrders.material})) = ${normalizeMaterialComparison(current.material)}`,
              sql`trim(${productionOrders.camisa}) = ${normalizeCamisa(current.camisa)}`,
            ),
          );

        if (duplicateActive) {
          return { kind: "DUPLICATE_ACTIVE_GROUP" as const };
        }
      }

      const [updated] = await tx
        .update(productionOrders)
        .set({ estado: blocked ? "BLOQUEADA" : "ACTIVA" })
        .where(eq(productionOrders.id, id))
        .returning();

      await logOrderEvent(tx, {
        ordenId: id,
        usuarioId: req.authUser?.id ?? null,
        accion: blocked ? "BLOQUEADA" : "DESBLOQUEADA",
      });

      const related = await tx
        .select()
        .from(productionOrderPedidos)
        .where(eq(productionOrderPedidos.ordenId, id))
        .orderBy(asc(productionOrderPedidos.vinculadoEn));

      return {
        kind: "UPDATED" as const,
        order: updated,
        total: numeric(total),
        pedidos: related.map((r) => ({
          id: r.id,
          pedidoId: r.pedidoId,
          numeroPedidoCliente: r.numeroPedidoCliente,
          metros: numeric(r.metros),
          vinculadoEn: r.vinculadoEn.toISOString(),
        })),
      };
    });

    if (result.kind === "MISSING") {
      res.status(404).json({ error: "La orden no existe" });
      return;
    }
    if (result.kind === "FINALIZED") {
      res.status(400).json({
        error: "Las órdenes finalizadas no se pueden bloquear ni desbloquear",
      });
      return;
    }
    if (result.kind === "DUPLICATE_ACTIVE_GROUP") {
      res.status(409).json({
        error:
          "No se puede desbloquear la orden porque ya existe otra orden activa para las mismas características",
        code: "CANNOT_UNBLOCK_DUPLICATE_ACTIVE_GROUP",
      });
      return;
    }
    res.json(orderView(result.order, result.total, result.pedidos));
  } catch (error: any) {
    const isDuplicateIndex =
      error?.code === "23505" ||
      error?.cause?.code === "23505" ||
      String(error?.message).includes("production_orders_gp_active_group_idx");
    if (isDuplicateIndex) {
      res.status(409).json({
        error:
          "No se puede desbloquear la orden porque ya existe otra orden activa para las mismas características",
        code: "CANNOT_UNBLOCK_DUPLICATE_ACTIVE_GROUP",
      });
      return;
    }
    next(error);
  }
});

router.post("/orders/:id/finalize", requireAdmin, async (req, res, next) => {
  try {
    const { id } = FinalizeOrderParams.parse({ id: Number(req.params.id) });
    const body = req.body ? FinalizeOrderBody.parse(req.body) : {};

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(productionOrders)
        .where(eq(productionOrders.id, id))
        .for("update");

      if (!current) return { kind: "MISSING" as const };

      if (current.estado !== "BLOQUEADA") {
        return { kind: "NOT_BLOCKED" as const };
      }

      const total = await computeOrderCoveredMeters(tx, id);

      const fabricados = total;
      const necesarios = numeric(current.metrosNecesarios);
      const faltantes = Math.max(0, necesarios - fabricados);
      const faltantesStr = new Intl.NumberFormat("es-ES", {
        maximumFractionDigits: 0,
      }).format(faltantes);

      // A pedido can be grouped into this order (by Nexus) between the
      // moment the operator opened the finalize dialog and the moment they
      // confirm it, silently raising the deficit they saw. Finalizing with
      // meters missing is the normal case here, so only stop when the number
      // the operator is looking at no longer matches the fresh one: then they
      // confirm again (`forzar`) over the up-to-date figure.
      const expected = body.faltantesEsperados;
      const deficitChanged =
        expected === undefined || Math.abs(expected - faltantes) > 0.01;
      if (faltantes > 0 && deficitChanged && !body.forzar) {
        return {
          kind: "PENDING_CONFIRMATION" as const,
          faltantes,
          faltantesStr,
        };
      }

      let notaFinal: string;
      if (body.nota && body.nota.trim().length > 0) {
        const trimmed = body.nota.trim();
        notaFinal = trimmed.toLowerCase().includes("faltan")
          ? trimmed
          : `${trimmed} (Faltan ${faltantesStr} m)`;
      } else {
        notaFinal = `Finalizada manualmente con ${faltantesStr} m faltantes`;
      }

      const [updated] = await tx
        .update(productionOrders)
        .set({
          estado: "FINALIZADA",
          finalizadaEn: new Date(),
          nota: notaFinal,
        })
        .where(eq(productionOrders.id, id))
        .returning();

      await logOrderEvent(tx, {
        ordenId: id,
        usuarioId: req.authUser?.id ?? null,
        accion: "FINALIZADA_MANUAL",
        detalle: notaFinal,
      });

      const related = await tx
        .select()
        .from(productionOrderPedidos)
        .where(eq(productionOrderPedidos.ordenId, id))
        .orderBy(asc(productionOrderPedidos.vinculadoEn));

      return {
        kind: "UPDATED" as const,
        order: updated,
        total: fabricados,
        pedidos: related.map((r) => ({
          id: r.id,
          pedidoId: r.pedidoId,
          numeroPedidoCliente: r.numeroPedidoCliente,
          metros: numeric(r.metros),
          vinculadoEn: r.vinculadoEn.toISOString(),
        })),
      };
    });

    if (result.kind === "MISSING") {
      res.status(404).json({ error: "La orden no existe" });
      return;
    }

    if (result.kind === "NOT_BLOCKED") {
      res.status(400).json({
        error:
          "Solo se pueden finalizar manualmente órdenes que estén bloqueadas",
      });
      return;
    }

    if (result.kind === "PENDING_CONFIRMATION") {
      res.status(409).json({
        error: `Los metros faltantes de esta orden son ahora ${result.faltantesStr} m. Confirma para finalizarla con ese dato.`,
        code: "FINALIZE_METERS_DEFICIT",
        faltantes: result.faltantes,
      });
      return;
    }

    res.json(orderView(result.order, result.total, result.pedidos));
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/reopen", requireAdmin, async (req, res, next) => {
  try {
    const { id } = ReopenOrderParams.parse({ id: Number(req.params.id) });
    const body = req.body ? ReopenOrderBody.parse(req.body) : {};

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(productionOrders)
        .where(eq(productionOrders.id, id))
        .for("update");

      if (!current) return { kind: "MISSING" as const };

      if (current.estado !== "FINALIZADA") {
        return { kind: "NOT_FINALIZED" as const };
      }

      const motivo = body.motivo?.trim();
      // Keep the finalize note: it says how many meters were left unmade, and
      // that is still the history of this order after reopening it.
      const notaReapertura = motivo
        ? `Reabierta: ${motivo}`
        : "Reabierta manualmente";
      const notaPrevia = current.nota?.trim();
      const notaFinal = notaPrevia
        ? `${notaPrevia} · ${notaReapertura}`
        : notaReapertura;

      // Reopen into BLOQUEADA rather than ACTIVA: the operator must
      // consciously unblock it, instead of it silently re-entering the
      // active/Nexus-grouping flow the moment it reopens.
      const [updated] = await tx
        .update(productionOrders)
        .set({
          estado: "BLOQUEADA",
          finalizadaEn: null,
          nota: notaFinal,
        })
        .where(eq(productionOrders.id, id))
        .returning();

      await logOrderEvent(tx, {
        ordenId: id,
        usuarioId: req.authUser?.id ?? null,
        accion: "REABIERTA",
        detalle: motivo ?? null,
      });

      const total = await computeOrderCoveredMeters(tx, id);
      const related = await tx
        .select()
        .from(productionOrderPedidos)
        .where(eq(productionOrderPedidos.ordenId, id))
        .orderBy(asc(productionOrderPedidos.vinculadoEn));

      return {
        kind: "UPDATED" as const,
        order: updated,
        total: numeric(total),
        pedidos: related.map((r) => ({
          id: r.id,
          pedidoId: r.pedidoId,
          numeroPedidoCliente: r.numeroPedidoCliente,
          metros: numeric(r.metros),
          vinculadoEn: r.vinculadoEn.toISOString(),
        })),
      };
    });

    if (result.kind === "MISSING") {
      res.status(404).json({ error: "La orden no existe" });
      return;
    }

    if (result.kind === "NOT_FINALIZED") {
      res.status(400).json({
        error: "Solo se pueden reabrir órdenes finalizadas",
      });
      return;
    }

    res.json(orderView(result.order, result.total, result.pedidos));
  } catch (error) {
    next(error);
  }
});

router.get("/orders/:id/events", async (req, res, next) => {
  try {
    const { id } = ListOrderEventsParams.parse({ id: Number(req.params.id) });

    const [order] = await db
      .select({ id: productionOrders.id })
      .from(productionOrders)
      .where(eq(productionOrders.id, id));
    if (!order) {
      res.status(404).json({ error: "La orden no existe" });
      return;
    }

    const rows = await db
      .select({
        id: productionOrderEvents.id,
        ordenId: productionOrderEvents.ordenId,
        usuarioId: productionOrderEvents.usuarioId,
        usuarioNombre: users.nombre,
        accion: productionOrderEvents.accion,
        detalle: productionOrderEvents.detalle,
        creadoEn: productionOrderEvents.creadoEn,
      })
      .from(productionOrderEvents)
      .leftJoin(users, eq(users.id, productionOrderEvents.usuarioId))
      .where(eq(productionOrderEvents.ordenId, id))
      .orderBy(desc(productionOrderEvents.creadoEn));

    res.json(
      rows.map((row) => ({
        id: row.id,
        ordenId: row.ordenId,
        usuarioId: row.usuarioId,
        usuarioNombre: row.usuarioNombre,
        accion: row.accion,
        detalle: row.detalle,
        creadoEn: row.creadoEn.toISOString(),
      })),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/orders/:id/coils", async (req, res, next) => {
  try {
    const { id } = ListOrderCoilsParams.parse({ id: Number(req.params.id) });
    // Coils manufactured for the order (and not committed elsewhere) plus
    // pre-existing stock coils assigned to the order.
    const items = await db
      .select()
      .from(coils)
      .where(
        sql`(${coils.ordenId} = ${id} and not exists (
          select 1 from ${productionOrderCoilAssignments} assignment
          where assignment.coil_id = ${coils.id}
        )) or (
          exists (
            select 1 from ${productionOrderCoilAssignments} assignment
            where assignment.coil_id = ${coils.id} and assignment.orden_id = ${id}
          )
        )`,
      )
      .orderBy(asc(coils.id));
    const views = await buildCoilViews(items, id);
    res.json(views);
  } catch (error) {
    next(error);
  }
});

router.get("/inventory", async (req, res, next) => {
  try {
    const query = ListInventoryQueryParams.parse(req.query);
    const targetStatus = query.status ?? "DISPONIBLE";
    const isFactory = targetStatus === "EN FÁBRICA";
    const baseQuery = db
      .select()
      .from(coils)
      .where(eq(coils.estado, targetStatus))
      .orderBy(
        ...(isFactory
          ? [sql`${coils.movidoAFabricaEn} DESC NULLS LAST`, desc(coils.id)]
          : [asc(coils.id)]),
      );
    const items = isFactory ? await baseQuery.limit(25) : await baseQuery;
    const views = await buildCoilViews(items);
    const totalMetros = items.reduce(
      (total, item) => total + numeric(item.metros),
      0,
    );
    res.json({ totalMetros, items: views });
  } catch (error) {
    next(error);
  }
});

router.post("/inventory/coils", async (req, res, next) => {
  try {
    const body = AddManufacturedCoilBody.parse(req.body);
    const { created, related } = await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(productionOrders)
        .where(eq(productionOrders.id, body.ordenId))
        .for("update");
      if (!order || (order.estado !== "ACTIVA" && order.estado !== "BLOQUEADA"))
        throw new Error("ORDER_INACTIVE");
      const [inserted] = await tx
        .insert(coils)
        .values({
          tipo: "BOBINA",
          metros: String(body.metros),
          ancho: order.ancho,
          micras: order.micras,
          camisa: order.camisa,
          material: order.material,
          estado: "DISPONIBLE",
          ordenId: order.id,
        })
        .returning();
      const covered = await computeOrderCoveredMeters(tx, order.id);
      if (covered >= numeric(order.metrosNecesarios)) {
        await tx
          .update(productionOrders)
          .set({ estado: "FINALIZADA", finalizadaEn: new Date() })
          .where(eq(productionOrders.id, order.id));
        await logOrderEvent(tx, {
          ordenId: order.id,
          usuarioId: req.authUser?.id ?? null,
          accion: "FINALIZADA_AUTO",
          detalle: "Auto-finalizada al cubrir los metros necesarios",
        });
      }
      const relatedRecords = await tx
        .select()
        .from(productionOrderPedidos)
        .where(eq(productionOrderPedidos.ordenId, order.id))
        .orderBy(
          asc(productionOrderPedidos.vinculadoEn),
          asc(productionOrderPedidos.id),
        );
      const relatedList: RelatedPedidoView[] = relatedRecords.map((r) => ({
        id: r.id,
        pedidoId: r.pedidoId,
        numeroPedidoCliente: r.numeroPedidoCliente,
        metros: numeric(r.metros),
        vinculadoEn: r.vinculadoEn.toISOString(),
      }));
      return { created: inserted, related: relatedList };
    });
    res.status(201).json(coilView(created, related));
  } catch (error) {
    if (error instanceof Error && error.message === "ORDER_INACTIVE") {
      res.status(400).json({ error: "La orden ya no está activa" });
      return;
    }
    next(error);
  }
});

router.post("/inventory/remnants", async (req, res, next) => {
  try {
    const body = AddProductionRemnantBody.parse(req.body);
    const [created] = await db
      .insert(coils)
      .values({
        tipo: "RESTO",
        metros: String(body.metros),
        ancho: String(body.ancho),
        micras: String(body.micras),
        camisa: String(body.camisa),
        material: body.material,
        estado: "DISPONIBLE",
      })
      .returning();
    res.status(201).json(coilView(created, []));
  } catch (error) {
    next(error);
  }
});

router.post("/inventory/:id/consume", async (req, res, next) => {
  try {
    const { id } = ConsumeInventoryItemParams.parse({
      id: Number(req.params.id),
    });
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [coil] = await tx
        .update(coils)
        .set({
          estado: "EN FÁBRICA",
          movidoAFabricaEn: now,
        })
        .where(and(eq(coils.id, id), eq(coils.estado, "DISPONIBLE")))
        .returning();

      if (!coil) {
        return null;
      }

      // Guardar solo las 25 últimas bobinas de esa lista, eliminando automáticamente las más viejas
      const excessFactoryCoils = await tx
        .select({ id: coils.id })
        .from(coils)
        .where(eq(coils.estado, "EN FÁBRICA"))
        .orderBy(sql`${coils.movidoAFabricaEn} DESC NULLS LAST`, desc(coils.id))
        .offset(25);

      if (excessFactoryCoils.length > 0) {
        const idsToDelete = excessFactoryCoils.map((c) => c.id);
        await tx.delete(coils).where(inArray(coils.id, idsToDelete));
      }

      return coil;
    });

    if (!updated) {
      res.status(404).json({ error: "La bobina ya no está disponible" });
      return;
    }
    let related: RelatedPedidoView[] = [];
    if (updated.ordenId) {
      const pedidosMap = await getPedidosByOrderIds([updated.ordenId]);
      related = pedidosMap.get(updated.ordenId) ?? [];
    }
    res.json(coilView(updated, related));
  } catch (error) {
    next(error);
  }
});

router.post("/inventory/:id/restore", async (req, res, next) => {
  try {
    const { id } = RestoreInventoryItemParams.parse({
      id: Number(req.params.id),
    });
    const [updated] = await db
      .update(coils)
      .set({
        estado: "DISPONIBLE",
        movidoAFabricaEn: null,
      })
      .where(and(eq(coils.id, id), eq(coils.estado, "EN FÁBRICA")))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "La bobina no está en fábrica o no existe" });
      return;
    }
    let related: RelatedPedidoView[] = [];
    if (updated.ordenId) {
      const pedidosMap = await getPedidosByOrderIds([updated.ordenId]);
      related = pedidosMap.get(updated.ordenId) ?? [];
    }
    res.json(coilView(updated, related));
  } catch (error) {
    next(error);
  }
});

// Edits fields (metros, material, camisa) of one individual physical coil in warehouse.
// Never touches characteristics of the order that originally produced the coil.
router.patch("/inventory/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = UpdateCoilParams.parse({
      id: Number(req.params.id),
    });
    const body = UpdateCoilBody.parse(req.body);

    const updateFields: {
      material?: string;
      metros?: string;
      camisa?: string;
    } = {};

    if (body.material !== undefined) {
      const material = body.material.trim();
      if (material.length === 0) {
        res.status(400).json({ error: "El material no puede estar vacío" });
        return;
      }
      updateFields.material = material;
    }

    if (body.camisa !== undefined) {
      const camisa = String(body.camisa).trim();
      if (camisa.length === 0) {
        res.status(400).json({ error: "La camisa no puede estar vacía" });
        return;
      }
      updateFields.camisa = camisa;
    }

    if (body.metros !== undefined) {
      const metros = Number(body.metros);
      if (Number.isNaN(metros) || metros <= 0) {
        res
          .status(400)
          .json({ error: "Los metros deben ser un número mayor a cero" });
        return;
      }
      updateFields.metros = String(metros);
    }

    if (Object.keys(updateFields).length === 0) {
      res.status(400).json({ error: "No se enviaron campos para actualizar" });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      const [coil] = await tx
        .select()
        .from(coils)
        .where(eq(coils.id, id))
        .for("update");
      if (!coil) return { kind: "MISSING" as const };
      if (coil.estado !== "DISPONIBLE") {
        return { kind: "NOT_AVAILABLE" as const, coil };
      }
      const [assignment] = await tx
        .select()
        .from(productionOrderCoilAssignments)
        .where(eq(productionOrderCoilAssignments.coilId, id));
      if (assignment) {
        return { kind: "ASSIGNED" as const, coil, assignment };
      }
      const [edited] = await tx
        .update(coils)
        .set(updateFields)
        .where(eq(coils.id, id))
        .returning();
      return { kind: "UPDATED" as const, coil: edited };
    });

    if (updated.kind === "MISSING") {
      res.status(404).json({ error: "La bobina no existe" });
      return;
    }
    if (updated.kind === "NOT_AVAILABLE") {
      res.status(409).json({
        error: "Solo se pueden editar bobinas disponibles en almacén",
        code: "COIL_NOT_AVAILABLE",
      });
      return;
    }
    if (updated.kind === "ASSIGNED") {
      res.status(409).json({
        error: `La bobina está asignada a la orden ORD-${String(
          updated.assignment.ordenId,
        ).padStart(4, "0")}. No se puede editar mientras esté comprometida.`,
        code: "COIL_COMMITTED_TO_ORDER",
      });
      return;
    }

    let related: RelatedPedidoView[] = [];
    if (updated.coil.ordenId) {
      const pedidosMap = await getPedidosByOrderIds([updated.coil.ordenId]);
      related = pedidosMap.get(updated.coil.ordenId) ?? [];
    }
    res.json(coilView(updated.coil, related));
  } catch (error) {
    next(error);
  }
});

// Edits the material of one individual physical coil. Never touches the
// characteristics of the order that originally produced the coil, and never
// modifies sibling coils of the same group.
router.patch("/inventory/:id/material", requireAuth, async (req, res, next) => {
  try {
    const { id } = UpdateCoilMaterialParams.parse({
      id: Number(req.params.id),
    });
    const body = UpdateCoilMaterialBody.parse(req.body);
    const material = body.material.trim();
    if (material.length === 0) {
      res.status(400).json({ error: "El material no puede estar vacío" });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      const [coil] = await tx
        .select()
        .from(coils)
        .where(eq(coils.id, id))
        .for("update");
      if (!coil) return { kind: "MISSING" as const };
      if (coil.estado !== "DISPONIBLE") {
        return { kind: "NOT_AVAILABLE" as const, coil };
      }
      const [assignment] = await tx
        .select()
        .from(productionOrderCoilAssignments)
        .where(eq(productionOrderCoilAssignments.coilId, id));
      if (assignment) {
        return { kind: "ASSIGNED" as const, coil, assignment };
      }
      const [edited] = await tx
        .update(coils)
        .set({ material })
        .where(eq(coils.id, id))
        .returning();
      return { kind: "UPDATED" as const, coil: edited };
    });

    if (updated.kind === "MISSING") {
      res.status(404).json({ error: "La bobina no existe" });
      return;
    }
    if (updated.kind === "NOT_AVAILABLE") {
      res.status(409).json({
        error:
          "Solo se puede editar el material de bobinas disponibles en almacén",
        code: "COIL_NOT_AVAILABLE",
      });
      return;
    }
    if (updated.kind === "ASSIGNED") {
      res.status(409).json({
        error: `La bobina está asignada a la orden ORD-${String(
          updated.assignment.ordenId,
        ).padStart(4, "0")} y su material no se puede modificar`,
        code: "COIL_ASSIGNED_TO_ORDER",
      });
      return;
    }

    let related: RelatedPedidoView[] = [];
    if (updated.coil.ordenId) {
      const pedidosMap = await getPedidosByOrderIds([updated.coil.ordenId]);
      related = pedidosMap.get(updated.coil.ordenId) ?? [];
    }
    res.json(coilView(updated.coil, related));
  } catch (error) {
    next(error);
  }
});

export default router;
