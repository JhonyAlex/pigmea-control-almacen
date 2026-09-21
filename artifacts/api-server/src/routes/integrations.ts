import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  productionOrderEvents,
  productionOrders,
  productionOrderPedidos,
} from "@workspace/db/schema";
import { requireIntegrationAuth } from "../middlewares/integration-auth";
import { logger } from "../lib/logger";
import {
  getNexusGroupKey,
  normalizeCamisa,
  normalizeMaterialComparison,
  normalizeMaterialStorage,
} from "../lib/nexus-order-normalizer";

const router: IRouter = Router();

const NexusOrderRequestSchema = z.object({
  eventId: z.string().uuid("eventId debe ser un UUID válido"),
  pedidoId: z.string().trim().min(1, "pedidoId no puede estar vacío"),
  numeroPedidoCliente: z
    .string()
    .trim()
    .min(1, "numeroPedidoCliente no puede estar vacío"),
  metros: z.number().positive("metros debe ser un número positivo").finite(),
  bobinaMadre: z
    .number()
    .positive("bobinaMadre debe ser un número positivo")
    .finite(),
  camisa: z.string().trim().min(1, "camisa no puede estar vacía"),
  tipoMaterial: z.string().trim().min(1, "tipoMaterial no puede estar vacío"),
  micras: z.number().positive("micras debe ser un número positivo").finite(),
});

router.post(
  "/integrations/gestion-pedidos/nexus-orders",
  requireIntegrationAuth,
  async (req, res, next) => {
    try {
      const parseResult = NexusOrderRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: "Datos de entrada inválidos",
          code: "VALIDATION_ERROR",
          details: parseResult.error.issues.map(({ path, message }) => ({
            path: path.join("."),
            message,
          })),
        });
        return;
      }

      const payload = parseResult.data;
      const groupKey = getNexusGroupKey({
        ancho: payload.bobinaMadre,
        micras: payload.micras,
        material: payload.tipoMaterial,
        camisa: payload.camisa,
      });

      const result = await db.transaction(async (tx) => {
        // 1. Acquire PostgreSQL transactional advisory lock on normalized group key
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"nexus_group:" + groupKey}, 0))`,
        );

        // 2. Check idempotency by eventId
        const [existingRelation] = await tx
          .select()
          .from(productionOrderPedidos)
          .where(eq(productionOrderPedidos.eventId, payload.eventId));

        if (existingRelation) {
          const [associatedOrder] = await tx
            .select()
            .from(productionOrders)
            .where(eq(productionOrders.id, existingRelation.ordenId));

          const isSamePedidoId = existingRelation.pedidoId === payload.pedidoId;
          const isSameNumero =
            existingRelation.numeroPedidoCliente ===
            payload.numeroPedidoCliente;
          const isSameMetros =
            Math.abs(Number(existingRelation.metros) - payload.metros) < 0.0001;

          const isSameOrderGroup =
            associatedOrder &&
            Math.abs(Number(associatedOrder.ancho) - payload.bobinaMadre) <
              0.0001 &&
            Math.abs(Number(associatedOrder.micras) - payload.micras) <
              0.0001 &&
            normalizeMaterialComparison(associatedOrder.material) ===
              normalizeMaterialComparison(payload.tipoMaterial) &&
            normalizeCamisa(associatedOrder.camisa) ===
              normalizeCamisa(payload.camisa);

          if (
            isSamePedidoId &&
            isSameNumero &&
            isSameMetros &&
            isSameOrderGroup
          ) {
            return {
              status: 200 as const,
              body: {
                success: true,
                action: "ALREADY_PROCESSED" as const,
                orderId: associatedOrder.id,
                totalMetros: Number(associatedOrder.metrosNecesarios),
                eventId: payload.eventId,
              },
            };
          }

          return {
            status: 409 as const,
            body: {
              error: "El eventId ya fue utilizado con un payload diferente",
              code: "IDEMPOTENCY_CONFLICT" as const,
            },
          };
        }

        // 3. Search for compatible active automatic order (ACTIVA + GESTION_PEDIDOS)
        const anchoStr = Number(payload.bobinaMadre).toFixed(2);
        const micrasStr = Number(payload.micras).toFixed(2);
        const materialComp = normalizeMaterialComparison(payload.tipoMaterial);
        const camisaNorm = normalizeCamisa(payload.camisa);

        const [compatibleOrder] = await tx
          .select()
          .from(productionOrders)
          .where(
            and(
              eq(productionOrders.estado, "ACTIVA"),
              eq(productionOrders.origen, "GESTION_PEDIDOS"),
              eq(productionOrders.ancho, anchoStr),
              eq(productionOrders.micras, micrasStr),
              sql`lower(trim(${productionOrders.material})) = ${materialComp}`,
              sql`trim(${productionOrders.camisa}) = ${camisaNorm}`,
            ),
          )
          .for("update");

        if (compatibleOrder) {
          // Reuse compatible order: insert relation
          await tx.insert(productionOrderPedidos).values({
            ordenId: compatibleOrder.id,
            eventId: payload.eventId,
            pedidoId: payload.pedidoId,
            numeroPedidoCliente: payload.numeroPedidoCliente,
            metros: String(payload.metros),
          });

          await tx.insert(productionOrderEvents).values({
            ordenId: compatibleOrder.id,
            usuarioId: null,
            accion: "PEDIDO_AGRUPADO",
            detalle: `Pedido ${payload.numeroPedidoCliente || payload.pedidoId} agrupado automáticamente (+${payload.metros} m)`,
          });

          // Recalculate total meters with PostgreSQL SUM
          const [{ total }] = await tx
            .select({
              total: sql<string>`coalesce(sum(${productionOrderPedidos.metros}), 0)`,
            })
            .from(productionOrderPedidos)
            .where(eq(productionOrderPedidos.ordenId, compatibleOrder.id));

          // Grouping only adds meters. The position in the list is manual
          // priority and nothing but an admin may change it, so the order
          // stays exactly where production left it.
          await tx
            .update(productionOrders)
            .set({ metrosNecesarios: total })
            .where(eq(productionOrders.id, compatibleOrder.id));

          return {
            status: 200 as const,
            body: {
              success: true,
              action: "ORDER_UPDATED" as const,
              orderId: compatibleOrder.id,
              totalMetros: Number(total),
              eventId: payload.eventId,
            },
          };
        }

        // No compatible active order: create new GESTION_PEDIDOS order
        await tx.execute(sql`select pg_advisory_xact_lock(481929)`);
        const [newOrder] = await tx
          .insert(productionOrders)
          .values({
            ancho: anchoStr,
            micras: micrasStr,
            camisa: camisaNorm,
            material: normalizeMaterialStorage(payload.tipoMaterial),
            metrosNecesarios: String(payload.metros),
            estado: "ACTIVA",
            origen: "GESTION_PEDIDOS",
            // Same rule as a manually created order: it goes last, below
            // everything already queued. Taking the maximum over every row
            // keeps `orden` unique across the list.
            orden: sql`coalesce((select max(${productionOrders.orden}) from ${productionOrders}), -1) + 1`,
          })
          .returning();

        await tx.insert(productionOrderPedidos).values({
          ordenId: newOrder.id,
          eventId: payload.eventId,
          pedidoId: payload.pedidoId,
          numeroPedidoCliente: payload.numeroPedidoCliente,
          metros: String(payload.metros),
        });

        const [{ total }] = await tx
          .select({
            total: sql<string>`coalesce(sum(${productionOrderPedidos.metros}), 0)`,
          })
          .from(productionOrderPedidos)
          .where(eq(productionOrderPedidos.ordenId, newOrder.id));

        await tx
          .update(productionOrders)
          .set({ metrosNecesarios: total })
          .where(eq(productionOrders.id, newOrder.id));

        return {
          status: 201 as const,
          body: {
            success: true,
            action: "ORDER_CREATED" as const,
            orderId: newOrder.id,
            totalMetros: Number(total),
            eventId: payload.eventId,
          },
        };
      });

      logger.info(
        {
          eventId: payload.eventId,
          pedidoId: payload.pedidoId,
          orderId: "orderId" in result.body ? result.body.orderId : undefined,
          action: "action" in result.body ? result.body.action : undefined,
          status: result.status,
        },
        "Nexus integration order processed",
      );

      res.status(result.status).json(result.body);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const pgCode = (error as { code?: string }).code;
        if (pgCode === "23505") {
          // Unique constraint violation (e.g. event_id or partial group unique index)
          logger.warn(
            { err: error },
            "Controlled constraint conflict in Nexus integration",
          );
          res.status(409).json({
            error: "Conflicto de unicidad al procesar la orden",
            code: "CONFLICT",
          });
          return;
        }
      }
      next(error);
    }
  },
);

export default router;
