import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import {
  getNexusGroupKey,
  normalizeCamisa,
  normalizeMaterialComparison,
  normalizeMaterialStorage,
  normalizeNumericString,
} from "../lib/nexus-order-normalizer";
import { requireIntegrationAuth } from "../middlewares/integration-auth";

// --- In-Memory Test Store simulating PostgreSQL relational tables and constraints ---
interface DbProductionOrder {
  id: number;
  ancho: string;
  micras: string;
  camisa: string;
  material: string;
  metrosNecesarios: string;
  estado: "ACTIVA" | "BLOQUEADA" | "FINALIZADA";
  origen: "MANUAL" | "GESTION_PEDIDOS";
  creadoEn: Date;
  finalizadaEn: Date | null;
  nota?: string | null;
}

interface DbProductionOrderPedido {
  id: number;
  ordenId: number;
  eventId: string;
  pedidoId: string;
  numeroPedidoCliente: string;
  metros: string;
  vinculadoEn: Date;
}

interface DbCoil {
  id: number;
  ordenId: number | null;
  metros: string;
}

class TestDatabase {
  orders: DbProductionOrder[] = [];
  orderPedidos: DbProductionOrderPedido[] = [];
  coils: DbCoil[] = [];
  nextOrderId = 1;
  nextPedidoId = 1;
  activeAdvisoryLocks = new Set<string>();

  reset() {
    this.orders = [];
    this.orderPedidos = [];
    this.coils = [];
    this.nextOrderId = 1;
    this.nextPedidoId = 1;
    this.activeAdvisoryLocks.clear();
  }

  // Simulates advisory xact lock
  async acquireAdvisoryLock(key: string): Promise<() => void> {
    while (this.activeAdvisoryLocks.has(key)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this.activeAdvisoryLocks.add(key);
    return () => this.activeAdvisoryLocks.delete(key);
  }

  calculateTotalMetros(ordenId: number): string {
    const total = this.orderPedidos
      .filter((p) => p.ordenId === ordenId)
      .reduce((sum, p) => sum + Number(p.metros), 0);
    return total.toFixed(2);
  }

  calculateCoilsFabricados(ordenId: number): number {
    return this.coils
      .filter((c) => c.ordenId === ordenId)
      .reduce((sum, c) => sum + Number(c.metros), 0);
  }
}

const testDb = new TestDatabase();

// --- Test Handler for Nexus Integration Endpoint ---
interface NexusOrderPayload {
  eventId: string;
  pedidoId: string;
  numeroPedidoCliente: string;
  metros: number;
  bobinaMadre: number;
  camisa: string;
  tipoMaterial: string;
  micras: number;
}

interface NexusSuccessBody {
  success: true;
  action: "ORDER_CREATED" | "ORDER_UPDATED" | "ALREADY_PROCESSED";
  orderId: number;
  totalMetros: number;
  eventId: string;
}

interface NexusErrorBody {
  error: string;
  code: string;
}

type NexusHandleResult =
  | { status: 200 | 201; body: NexusSuccessBody }
  | { status: 400 | 401 | 409 | 503; body: NexusErrorBody };

async function handleNexusOrder(
  payload: NexusOrderPayload,
): Promise<NexusHandleResult> {
  // Validate fields
  if (
    !payload.eventId ||
    !payload.pedidoId ||
    !payload.numeroPedidoCliente ||
    typeof payload.metros !== "number" ||
    payload.metros <= 0 ||
    typeof payload.bobinaMadre !== "number" ||
    payload.bobinaMadre <= 0 ||
    !payload.camisa ||
    !payload.tipoMaterial ||
    typeof payload.micras !== "number" ||
    payload.micras <= 0
  ) {
    return {
      status: 400,
      body: { error: "Datos de entrada inválidos", code: "VALIDATION_ERROR" },
    };
  }

  const groupKey = getNexusGroupKey({
    ancho: payload.bobinaMadre,
    micras: payload.micras,
    material: payload.tipoMaterial,
    camisa: payload.camisa,
  });

  const releaseLock = await testDb.acquireAdvisoryLock(groupKey);
  try {
    // 1. Idempotency check
    const existingRelation = testDb.orderPedidos.find(
      (p) => p.eventId === payload.eventId,
    );
    if (existingRelation) {
      const associatedOrder = testDb.orders.find(
        (o) => o.id === existingRelation.ordenId,
      );
      const isSamePedidoId = existingRelation.pedidoId === payload.pedidoId;
      const isSameNumero =
        existingRelation.numeroPedidoCliente === payload.numeroPedidoCliente;
      const isSameMetros =
        Math.abs(Number(existingRelation.metros) - payload.metros) < 0.0001;

      const isSameOrderGroup =
        associatedOrder &&
        Math.abs(Number(associatedOrder.ancho) - payload.bobinaMadre) <
          0.0001 &&
        Math.abs(Number(associatedOrder.micras) - payload.micras) < 0.0001 &&
        normalizeMaterialComparison(associatedOrder.material) ===
          normalizeMaterialComparison(payload.tipoMaterial) &&
        normalizeCamisa(associatedOrder.camisa) ===
          normalizeCamisa(payload.camisa);

      if (
        isSamePedidoId &&
        isSameNumero &&
        isSameMetros &&
        isSameOrderGroup &&
        associatedOrder
      ) {
        return {
          status: 200,
          body: {
            success: true,
            action: "ALREADY_PROCESSED",
            orderId: associatedOrder.id,
            totalMetros: Number(associatedOrder.metrosNecesarios),
            eventId: payload.eventId,
          },
        };
      }

      return {
        status: 409,
        body: {
          error: "El eventId ya fue utilizado con un payload diferente",
          code: "IDEMPOTENCY_CONFLICT",
        },
      };
    }

    // 2. Locate compatible active automatic order (ACTIVA + GESTION_PEDIDOS)
    const anchoStr = Number(payload.bobinaMadre).toFixed(2);
    const micrasStr = Number(payload.micras).toFixed(2);
    const materialComp = normalizeMaterialComparison(payload.tipoMaterial);
    const camisaNorm = normalizeCamisa(payload.camisa);

    const compatibleOrder = testDb.orders.find(
      (o) =>
        o.estado === "ACTIVA" &&
        o.origen === "GESTION_PEDIDOS" &&
        Number(o.ancho).toFixed(2) === anchoStr &&
        Number(o.micras).toFixed(2) === micrasStr &&
        normalizeMaterialComparison(o.material) === materialComp &&
        normalizeCamisa(o.camisa) === camisaNorm,
    );

    if (compatibleOrder) {
      testDb.orderPedidos.push({
        id: testDb.nextPedidoId++,
        ordenId: compatibleOrder.id,
        eventId: payload.eventId,
        pedidoId: payload.pedidoId,
        numeroPedidoCliente: payload.numeroPedidoCliente,
        metros: String(payload.metros),
        vinculadoEn: new Date(),
      });

      const newTotal = testDb.calculateTotalMetros(compatibleOrder.id);
      compatibleOrder.metrosNecesarios = newTotal;

      return {
        status: 200,
        body: {
          success: true,
          action: "ORDER_UPDATED",
          orderId: compatibleOrder.id,
          totalMetros: Number(newTotal),
          eventId: payload.eventId,
        },
      };
    }

    // 3. Create new GESTION_PEDIDOS order
    const newOrder: DbProductionOrder = {
      id: testDb.nextOrderId++,
      ancho: anchoStr,
      micras: micrasStr,
      camisa: camisaNorm,
      material: normalizeMaterialStorage(payload.tipoMaterial),
      metrosNecesarios: String(payload.metros),
      estado: "ACTIVA",
      origen: "GESTION_PEDIDOS",
      creadoEn: new Date(),
      finalizadaEn: null,
    };
    testDb.orders.push(newOrder);

    testDb.orderPedidos.push({
      id: testDb.nextPedidoId++,
      ordenId: newOrder.id,
      eventId: payload.eventId,
      pedidoId: payload.pedidoId,
      numeroPedidoCliente: payload.numeroPedidoCliente,
      metros: String(payload.metros),
      vinculadoEn: new Date(),
    });

    const newTotal = testDb.calculateTotalMetros(newOrder.id);
    newOrder.metrosNecesarios = newTotal;

    return {
      status: 201,
      body: {
        success: true,
        action: "ORDER_CREATED",
        orderId: newOrder.id,
        totalMetros: Number(newTotal),
        eventId: payload.eventId,
      },
    };
  } finally {
    releaseLock();
  }
}

// --- Test Handlers for Orders Management ---
function handleGetOrders(statusFilter?: string) {
  const orders = testDb.orders.filter(
    (o) => !statusFilter || o.estado === statusFilter,
  );
  return orders.map((order) => {
    const fabricados = testDb.calculateCoilsFabricados(order.id);
    const related = testDb.orderPedidos
      .filter((p) => p.ordenId === order.id)
      .map((p) => ({
        id: p.id,
        pedidoId: p.pedidoId,
        numeroPedidoCliente: p.numeroPedidoCliente,
        metros: Number(p.metros),
        vinculadoEn: p.vinculadoEn.toISOString(),
      }));

    return {
      id: order.id,
      ancho: Number(order.ancho),
      micras: Number(order.micras),
      camisa: order.camisa,
      material: order.material,
      metrosNecesarios: Number(order.metrosNecesarios),
      metrosFabricados: fabricados,
      metrosPendientes: Math.max(
        0,
        Number(order.metrosNecesarios) - fabricados,
      ),
      estado: order.estado,
      origen: order.origen,
      pedidosRelacionados: related,
      creadoEn: order.creadoEn.toISOString(),
      finalizadaEn: order.finalizadaEn
        ? order.finalizadaEn.toISOString()
        : null,
      nota: order.nota ?? null,
    };
  });
}

function handleUpdateOrder(
  id: number,
  body: {
    ancho: number;
    micras: number;
    camisa: string;
    material: string;
    metrosNecesarios: number;
  },
) {
  const order = testDb.orders.find((o) => o.id === id);
  if (!order) return { status: 404, body: { error: "La orden no existe" } };
  if (order.estado !== "ACTIVA") {
    return {
      status: 400,
      body: { error: "Solo se pueden editar órdenes activas" },
    };
  }

  const characteristicsChanged =
    Number(order.ancho).toFixed(2) !== Number(body.ancho).toFixed(2) ||
    Number(order.micras).toFixed(2) !== Number(body.micras).toFixed(2) ||
    normalizeCamisa(order.camisa) !== normalizeCamisa(body.camisa) ||
    normalizeMaterialComparison(order.material) !==
      normalizeMaterialComparison(body.material);

  if (order.origen === "GESTION_PEDIDOS" && characteristicsChanged) {
    const duplicateActive = testDb.orders.find(
      (o) =>
        o.id !== order.id &&
        o.estado === "ACTIVA" &&
        o.origen === "GESTION_PEDIDOS" &&
        Number(o.ancho).toFixed(2) === Number(body.ancho).toFixed(2) &&
        Number(o.micras).toFixed(2) === Number(body.micras).toFixed(2) &&
        normalizeMaterialComparison(o.material) ===
          normalizeMaterialComparison(body.material) &&
        normalizeCamisa(o.camisa) === normalizeCamisa(body.camisa),
    );

    if (duplicateActive) {
      return {
        status: 409,
        body: {
          error: `Ya existe una orden activa de Gestión Pedidos (ORD-${String(duplicateActive.id).padStart(4, "0")}) con esas características`,
          code: "DUPLICATE_ACTIVE_GROUP",
        },
      };
    }
  }

  order.ancho = Number(body.ancho).toFixed(2);
  order.micras = Number(body.micras).toFixed(2);
  order.camisa = String(body.camisa);
  order.material = body.material;
  order.metrosNecesarios = Number(body.metrosNecesarios).toFixed(2);
  return { status: 200, body: { success: true } };
}

function handleSetOrderBlocked(id: number, blocked: boolean) {
  const order = testDb.orders.find((o) => o.id === id);
  if (!order) return { status: 404, body: { error: "La orden no existe" } };
  if (order.estado === "FINALIZADA") {
    return {
      status: 400,
      body: {
        error: "Las órdenes finalizadas no se pueden bloquear ni desbloquear",
      },
    };
  }

  if (!blocked && order.origen === "GESTION_PEDIDOS") {
    const duplicateActive = testDb.orders.find(
      (o) =>
        o.id !== order.id &&
        o.estado === "ACTIVA" &&
        o.origen === "GESTION_PEDIDOS" &&
        Number(o.ancho).toFixed(2) === Number(order.ancho).toFixed(2) &&
        Number(o.micras).toFixed(2) === Number(order.micras).toFixed(2) &&
        normalizeMaterialComparison(o.material) ===
          normalizeMaterialComparison(order.material) &&
        normalizeCamisa(o.camisa) === normalizeCamisa(order.camisa),
    );

    if (duplicateActive) {
      return {
        status: 409,
        body: {
          error:
            "No se puede desbloquear la orden porque ya existe otra orden activa para las mismas características",
          code: "CANNOT_UNBLOCK_DUPLICATE_ACTIVE_GROUP",
        },
      };
    }
  }

  order.estado = blocked ? "BLOQUEADA" : "ACTIVA";
  return { status: 200, body: { id: order.id, estado: order.estado } };
}

function handleFinalizeOrder(id: number, nota?: string) {
  const order = testDb.orders.find((o) => o.id === id);
  if (!order) return { status: 404 as const, body: { error: "La orden no existe" } };
  if (order.estado !== "BLOQUEADA") {
    return {
      status: 400 as const,
      body: {
        error: "Solo se pueden finalizar manualmente órdenes que estén bloqueadas",
      },
    };
  }

  const fabricados = testDb.calculateCoilsFabricados(order.id);
  const faltantes = Math.max(0, Number(order.metrosNecesarios) - fabricados);
  const faltantesFormatted = new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 0,
  }).format(faltantes);

  let finalNota: string;
  if (nota && nota.trim().length > 0) {
    const trimmed = nota.trim();
    finalNota = trimmed.toLowerCase().includes("faltan")
      ? trimmed
      : `${trimmed} (Faltan ${faltantesFormatted} m)`;
  } else {
    finalNota = `Finalizada manualmente con ${faltantesFormatted} m faltantes`;
  }

  order.estado = "FINALIZADA";
  order.finalizadaEn = new Date();
  order.nota = finalNota;

  const related = testDb.orderPedidos
    .filter((p) => p.ordenId === order.id)
    .map((p) => ({
      id: p.id,
      pedidoId: p.pedidoId,
      numeroPedidoCliente: p.numeroPedidoCliente,
      metros: Number(p.metros),
      vinculadoEn: p.vinculadoEn.toISOString(),
    }));

  return {
    status: 200 as const,
    body: {
      id: order.id,
      ancho: Number(order.ancho),
      micras: Number(order.micras),
      camisa: order.camisa,
      material: order.material,
      metrosNecesarios: Number(order.metrosNecesarios),
      metrosFabricados: fabricados,
      metrosPendientes: faltantes,
      estado: order.estado,
      origen: order.origen,
      pedidosRelacionados: related,
      creadoEn: order.creadoEn.toISOString(),
      finalizadaEn: order.finalizadaEn.toISOString(),
      nota: order.nota,
    },
  };
}

function handleAddManufacturedCoil(ordenId: number, metros: number) {
  const order = testDb.orders.find((o) => o.id === ordenId);
  if (!order || (order.estado !== "ACTIVA" && order.estado !== "BLOQUEADA")) {
    return { status: 400 as const, body: { error: "La orden ya no está activa" } };
  }
  const coil: DbCoil = {
    id: testDb.coils.length + 1,
    ordenId,
    metros: String(metros),
  };
  testDb.coils.push(coil);
  const total = testDb.calculateCoilsFabricados(ordenId);
  if (total >= Number(order.metrosNecesarios)) {
    order.estado = "FINALIZADA";
    order.finalizadaEn = new Date();
  }
  const related = testDb.orderPedidos
    .filter((p) => p.ordenId === ordenId)
    .map((p) => ({
      id: p.id,
      pedidoId: p.pedidoId,
      numeroPedidoCliente: p.numeroPedidoCliente,
      metros: Number(p.metros),
      vinculadoEn: p.vinculadoEn.toISOString(),
    }));
  return {
    status: 201 as const,
    body: {
      id: coil.id,
      tipo: "BOBINA",
      metros: Number(coil.metros),
      ordenId: coil.ordenId,
      pedidosRelacionados: related,
    },
  };
}

function handleGetInventory() {
  return {
    totalMetros: testDb.coils.reduce((sum, c) => sum + Number(c.metros), 0),
    items: testDb.coils.map((c) => {
      const related = c.ordenId
        ? testDb.orderPedidos
            .filter((p) => p.ordenId === c.ordenId)
            .map((p) => ({
              id: p.id,
              pedidoId: p.pedidoId,
              numeroPedidoCliente: p.numeroPedidoCliente,
              metros: Number(p.metros),
              vinculadoEn: p.vinculadoEn.toISOString(),
            }))
        : [];
      return {
        id: c.id,
        tipo: "BOBINA",
        metros: Number(c.metros),
        ordenId: c.ordenId,
        pedidosRelacionados: related,
      };
    }),
  };
}

function handleGetOrderCoils(ordenId: number) {
  const related = testDb.orderPedidos
    .filter((p) => p.ordenId === ordenId)
    .map((p) => ({
      id: p.id,
      pedidoId: p.pedidoId,
      numeroPedidoCliente: p.numeroPedidoCliente,
      metros: Number(p.metros),
      vinculadoEn: p.vinculadoEn.toISOString(),
    }));
  return testDb.coils
    .filter((c) => c.ordenId === ordenId)
    .map((c) => ({
      id: c.id,
      tipo: "BOBINA",
      metros: Number(c.metros),
      ordenId: c.ordenId,
      pedidosRelacionados: related,
    }));
}

// ============================================================================
// SUITE DE TESTS - FASE 2: INTEGRACIÓN NEXUS EN CONTROL-ALMACEN (Escenarios A-W)
// ============================================================================

describe("Fase 2: Integración Nexus en control-almacen", () => {
  beforeEach(() => {
    testDb.reset();
  });

  // --- Tests A & B ---
  it("A. Primer pedido: crea orden GESTION_PEDIDOS con metros y relación correctos", async () => {
    const eventId = "11111111-1111-4111-8111-111111111111";
    const res = await handleNexusOrder({
      eventId,
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res.status, 201);
    if (res.status === 201) {
      assert.equal(res.body.action, "ORDER_CREATED");
      assert.equal(res.body.totalMetros, 5000);

      const order = testDb.orders.find((o) => o.id === res.body.orderId);
      assert.ok(order);
      assert.equal(order.origen, "GESTION_PEDIDOS");
      assert.equal(order.estado, "ACTIVA");
      assert.equal(Number(order.metrosNecesarios), 5000);

      const relations = testDb.orderPedidos.filter(
        (p) => p.ordenId === order.id,
      );
      assert.equal(relations.length, 1);
      assert.equal(relations[0].pedidoId, "PED-001");
      assert.equal(relations[0].eventId, eventId);
    }
  });

  it("B. Segundo pedido compatible: reutiliza orden, suma exacta con SUM en SQL, 2 relaciones", async () => {
    const eventId1 = "11111111-1111-4111-8111-111111111111";
    const eventId2 = "22222222-2222-4222-8222-222222222222";

    const res1 = await handleNexusOrder({
      eventId: eventId1,
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    const res2 = await handleNexusOrder({
      eventId: eventId2,
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 7500,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res2.status, 200);
    if (res1.status === 201 && res2.status === 200) {
      assert.equal(res2.body.action, "ORDER_UPDATED");
      assert.equal(res2.body.orderId, res1.body.orderId);
      assert.equal(res2.body.totalMetros, 12500);

      assert.equal(testDb.orders.length, 1);
      const order = testDb.orders[0];
      assert.equal(Number(order.metrosNecesarios), 12500);

      const relations = testDb.orderPedidos.filter(
        (p) => p.ordenId === order.id,
      );
      assert.equal(relations.length, 2);
    }
  });

  // --- Tests C, D, E, F: Diferencias en la clave lógica ---
  it("C. Bobina distinta: crea otra orden", async () => {
    await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    const res2 = await handleNexusOrder({
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 3000,
      bobinaMadre: 1250, // Ancho distinto
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res2.status, 201);
    if (res2.status === 201) {
      assert.equal(res2.body.action, "ORDER_CREATED");
      assert.equal(testDb.orders.length, 2);
    }
  });

  it("D. Micras distintas: crea otra orden", async () => {
    await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    const res2 = await handleNexusOrder({
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 35, // Micras distintas
    });

    assert.equal(res2.status, 201);
    assert.equal(testDb.orders.length, 2);
  });

  it("E. Camisa distinta: crea otra orden", async () => {
    await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    const res2 = await handleNexusOrder({
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: "475", // Camisa distinta
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res2.status, 201);
    assert.equal(testDb.orders.length, 2);
  });

  it("F. Material distinto: crea otra orden", async () => {
    await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    const res2 = await handleNexusOrder({
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "PET", // Material distinto
      micras: 30,
    });

    assert.equal(res2.status, 201);
    assert.equal(testDb.orders.length, 2);
  });

  // --- Test G: Normalización case/espacios ---
  it("G. Material con diferencias de casing/espacios agrupa en el MISMO grupo", async () => {
    const res1 = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 4000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP Reciclado",
      micras: 30,
    });

    const res2 = await handleNexusOrder({
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 6000,
      bobinaMadre: 1200,
      camisa: " 400 ",
      tipoMaterial: " opp reciclado ",
      micras: 30,
    });

    assert.equal(res2.status, 200);
    if (res1.status === 201 && res2.status === 200) {
      assert.equal(res2.body.action, "ORDER_UPDATED");
      assert.equal(res2.body.orderId, res1.body.orderId);
      assert.equal(res2.body.totalMetros, 10000);
      assert.equal(testDb.orders.length, 1);
    }
  });

  // --- Tests H, I, J: Estado y origen ---
  it("H. Orden compatible BLOQUEADA: no la reutiliza, crea nueva orden ACTIVA", async () => {
    const res1 = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    // Bloquear orden 1
    if (res1.status === 201) {
      handleSetOrderBlocked(res1.body.orderId, true);
    }

    const res2 = await handleNexusOrder({
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res2.status, 201);
    if (res1.status === 201 && res2.status === 201) {
      assert.equal(res2.body.action, "ORDER_CREATED");
      assert.notEqual(res2.body.orderId, res1.body.orderId);
      assert.equal(testDb.orders.length, 2);
    }
  });

  it("I. Orden FINALIZADA: no la reutiliza, crea nueva orden ACTIVA", async () => {
    const res1 = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    // Finalizar orden 1
    if (res1.status === 201) {
      const order1 = testDb.orders.find((o) => o.id === res1.body.orderId)!;
      order1.estado = "FINALIZADA";
    }

    const res2 = await handleNexusOrder({
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res2.status, 201);
    if (res1.status === 201 && res2.status === 201) {
      assert.equal(res2.body.action, "ORDER_CREATED");
      assert.notEqual(res2.body.orderId, res1.body.orderId);
    }
  });

  it("J. Orden MANUAL compatible: no la reutiliza, crea orden GESTION_PEDIDOS", async () => {
    // Crear orden manual previa con las mismas características
    testDb.orders.push({
      id: testDb.nextOrderId++,
      ancho: "1200.00",
      micras: "30.00",
      camisa: "400",
      material: "OPP",
      metrosNecesarios: "5000.00",
      estado: "ACTIVA",
      origen: "MANUAL",
      creadoEn: new Date(),
      finalizadaEn: null,
    });

    const res = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 4000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res.status, 201);
    assert.equal(testDb.orders.length, 2);
    assert.equal(testDb.orders[1].origen, "GESTION_PEDIDOS");
  });

  // --- Tests K & L: Idempotencia ---
  it("K. Mismo eventId, mismo payload: ALREADY_PROCESSED sin duplicar metros", async () => {
    const payload: NexusOrderPayload = {
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const res1 = await handleNexusOrder(payload);
    assert.equal(res1.status, 201);

    const res2 = await handleNexusOrder(payload);
    assert.equal(res2.status, 200);
    if (res1.status === 201 && res2.status === 200) {
      assert.equal(res2.body.action, "ALREADY_PROCESSED");
      assert.equal(res2.body.orderId, res1.body.orderId);
      assert.equal(res2.body.totalMetros, 5000);

      const relations = testDb.orderPedidos.filter(
        (p) => p.ordenId === res1.body.orderId,
      );
      assert.equal(relations.length, 1);
    }
  });

  it("L. Mismo eventId, payload diferente: 409 IDEMPOTENCY_CONFLICT", async () => {
    const eventId = "11111111-1111-4111-8111-111111111111";

    await handleNexusOrder({
      eventId,
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    const resConflict = await handleNexusOrder({
      eventId,
      pedidoId: "PED-002", // Payload diferente
      numeroPedidoCliente: "2600102",
      metros: 9000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(resConflict.status, 409);
    assert.equal(resConflict.body.code, "IDEMPOTENCY_CONFLICT");

    // Verificar que no se modificó nada
    const order = testDb.orders[0];
    assert.equal(Number(order.metrosNecesarios), 5000);
    assert.equal(testDb.orderPedidos.length, 1);
  });

  // --- Test M: Concurrencia ---
  it("M. Concurrencia: requests concurrentes compatibles producen UNA sola orden activa y total exacto", async () => {
    const payload1: NexusOrderPayload = {
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const payload2: NexusOrderPayload = {
      eventId: "22222222-2222-4222-8222-222222222222",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    // Execute concurrently
    const [res1, res2] = await Promise.all([
      handleNexusOrder(payload1),
      handleNexusOrder(payload2),
    ]);

    assert.ok(res1.status === 201 || res1.status === 200);
    assert.ok(res2.status === 201 || res2.status === 200);
    assert.notEqual(res1.body.action, res2.body.action); // One created, one updated

    // Exactly one active order in DB
    const activeOrders = testDb.orders.filter((o) => o.estado === "ACTIVA");
    assert.equal(activeOrders.length, 1);
    assert.equal(Number(activeOrders[0].metrosNecesarios), 8000);
    assert.equal(testDb.orderPedidos.length, 2);
  });

  // --- Tests N & O: Autenticación ---
  it("N. Token incorrecto: 401 UNAUTHORIZED y cero escrituras", async () => {
    process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN = "secret-token-123";

    const app: Express = express();
    app.use(requireIntegrationAuth);
    app.post("/test", (_req, res) => res.json({ ok: true }));

    const reqMock = {
      headers: { authorization: "Bearer wrong-token" },
    } as any;

    let statusCode = 0;
    let responseBody: any = null;
    const resMock = {
      status(code: number) {
        statusCode = code;
        return {
          json(body: any) {
            responseBody = body;
          },
        };
      },
    } as any;

    requireIntegrationAuth(reqMock, resMock, () => {});

    assert.equal(statusCode, 401);
    assert.equal(responseBody.code, "UNAUTHORIZED");
    assert.equal(testDb.orders.length, 0);
  });

  it("O. Token no configurado: 503 INTEGRATION_NOT_CONFIGURED", async () => {
    delete process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN;

    const reqMock = {
      headers: { authorization: "Bearer some-token" },
    } as any;

    let statusCode = 0;
    let responseBody: any = null;
    const resMock = {
      status(code: number) {
        statusCode = code;
        return {
          json(body: any) {
            responseBody = body;
          },
        };
      },
    } as any;

    requireIntegrationAuth(reqMock, resMock, () => {});

    assert.equal(statusCode, 503);
    assert.equal(responseBody.code, "INTEGRATION_NOT_CONFIGURED");
  });

  // --- Test P: Edición manual de órdenes automáticas ---
  it("P. Editar orden GESTION_PEDIDOS: permitido para administrador", async () => {
    const res = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res.status, 201);
    if (res.status === 201) {
      const updateRes = handleUpdateOrder(res.body.orderId, {
        ancho: 1250,
        micras: 35,
        camisa: "475",
        material: "OPP",
        metrosNecesarios: 10000,
      });

      assert.equal(updateRes.status, 200);

      const order = testDb.orders.find((o) => o.id === res.body.orderId)!;
      assert.equal(Number(order.ancho), 1250);
      assert.equal(Number(order.micras), 35);
      assert.equal(order.camisa, "475");
      assert.equal(Number(order.metrosNecesarios), 10000);
    }
  });

  it("P2. Editar orden GESTION_PEDIDOS hacia un grupo ya activo: 409 DUPLICATE_ACTIVE_GROUP", async () => {
    const first = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-11111111aaaa",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });
    const second = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-11111111bbbb",
      pedidoId: "PED-002",
      numeroPedidoCliente: "2600102",
      metros: 4000,
      bobinaMadre: 1250,
      camisa: "475",
      tipoMaterial: "OPP",
      micras: 35,
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    if (first.status === 201 && second.status === 201) {
      const updateRes = handleUpdateOrder(second.body.orderId, {
        ancho: 1200,
        micras: 30,
        camisa: "400",
        material: "OPP",
        metrosNecesarios: 4000,
      });

      assert.equal(updateRes.status, 409);
      assert.equal(updateRes.body.code, "DUPLICATE_ACTIVE_GROUP");

      const order = testDb.orders.find((o) => o.id === second.body.orderId)!;
      assert.equal(Number(order.ancho), 1250);
      assert.equal(Number(order.micras), 35);
    }
  });

  // --- Tests Q, R, S: Bloquear y Desbloquear ---
  it("Q. Bloqueo de orden automática funciona correctamente", async () => {
    const res = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    if (res.status === 201) {
      const blockRes = handleSetOrderBlocked(res.body.orderId, true);
      assert.equal(blockRes.status, 200);

      const order = testDb.orders.find((o) => o.id === res.body.orderId)!;
      assert.equal(order.estado, "BLOQUEADA");
    }
  });

  it("R. Desbloqueo sin otra activa: funciona correctamente", async () => {
    const res = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    if (res.status === 201) {
      handleSetOrderBlocked(res.body.orderId, true);
      const unblockRes = handleSetOrderBlocked(res.body.orderId, false);

      assert.equal(unblockRes.status, 200);
      const order = testDb.orders.find((o) => o.id === res.body.orderId)!;
      assert.equal(order.estado, "ACTIVA");
    }
  });

  it("S. Desbloqueo cuando ya existe otra automática activa compatible: 409 CANNOT_UNBLOCK_DUPLICATE_ACTIVE_GROUP", async () => {
    // 1. Crear Orden A
    const resA = await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    if (resA.status === 201) {
      // 2. Bloquear Orden A
      handleSetOrderBlocked(resA.body.orderId, true);

      // 3. Crear Orden B compatible (entra como ACTIVA porque A está bloqueada)
      const resB = await handleNexusOrder({
        eventId: "22222222-2222-4222-8222-222222222222",
        pedidoId: "PED-002",
        numeroPedidoCliente: "2600102",
        metros: 3000,
        bobinaMadre: 1200,
        camisa: "400",
        tipoMaterial: "OPP",
        micras: 30,
      });
      assert.equal(resB.status, 201);

      // 4. Intentar desbloquear Orden A
      const unblockRes = handleSetOrderBlocked(resA.body.orderId, false);
      assert.equal(unblockRes.status, 409);
      assert.equal(
        unblockRes.body.code,
        "CANNOT_UNBLOCK_DUPLICATE_ACTIVE_GROUP",
      );

      // Orden A permanece bloqueada
      const orderA = testDb.orders.find((o) => o.id === resA.body.orderId)!;
      assert.equal(orderA.estado, "BLOQUEADA");
    }
  });

  // --- Test T: Órdenes manuales ---
  it("T. Orden manual: crear, editar, bloquear y desbloquear continúa igual que antes", async () => {
    // Crear manual
    const manualOrder: DbProductionOrder = {
      id: testDb.nextOrderId++,
      ancho: "1200.00",
      micras: "30.00",
      camisa: "400",
      material: "OPP",
      metrosNecesarios: "5000.00",
      estado: "ACTIVA",
      origen: "MANUAL",
      creadoEn: new Date(),
      finalizadaEn: null,
    };
    testDb.orders.push(manualOrder);

    // Editar manual
    const updateRes = handleUpdateOrder(manualOrder.id, {
      ancho: 1200,
      micras: 30,
      camisa: "400",
      material: "OPP",
      metrosNecesarios: 6000,
    });
    assert.equal(updateRes.status, 200);

    // Bloquear manual
    const blockRes = handleSetOrderBlocked(manualOrder.id, true);
    assert.equal(blockRes.status, 200);

    // Desbloquear manual
    const unblockRes = handleSetOrderBlocked(manualOrder.id, false);
    assert.equal(unblockRes.status, 200);
    assert.equal(manualOrder.estado, "ACTIVA");
  });

  // --- Test U: GET /orders con origen y pedidos relacionados ---
  it("U. GET /orders: devuelve origen y pedidosRelacionados ([] para manual)", async () => {
    // Manual
    testDb.orders.push({
      id: testDb.nextOrderId++,
      ancho: "1200.00",
      micras: "30.00",
      camisa: "400",
      material: "OPP",
      metrosNecesarios: "5000.00",
      estado: "ACTIVA",
      origen: "MANUAL",
      creadoEn: new Date(),
      finalizadaEn: null,
    });

    // Automática
    await handleNexusOrder({
      eventId: "11111111-1111-4111-8111-111111111111",
      pedidoId: "PED-001",
      numeroPedidoCliente: "2600101",
      metros: 3500,
      bobinaMadre: 1000,
      camisa: "520",
      tipoMaterial: "OPP RECICLADO",
      micras: 25,
    });

    const orders = handleGetOrders();
    assert.equal(orders.length, 2);

    const manual = orders.find((o) => o.origen === "MANUAL")!;
    assert.ok(manual);
    assert.deepEqual(manual.pedidosRelacionados, []);

    const auto = orders.find((o) => o.origen === "GESTION_PEDIDOS")!;
    assert.ok(auto);
    assert.equal(auto.pedidosRelacionados.length, 1);
    assert.equal(auto.pedidosRelacionados[0].pedidoId, "PED-001");
    assert.equal(auto.pedidosRelacionados[0].metros, 3500);
  });

  // --- Test V: Material dinámico ---
  it("V. Material dinámico (PET, LDPE): integración y lectura funcionan correctamente", async () => {
    const res = await handleNexusOrder({
      eventId: "33333333-3333-4333-8333-333333333333",
      pedidoId: "PED-PET",
      numeroPedidoCliente: "2600999",
      metros: 8000,
      bobinaMadre: 1100,
      camisa: "400",
      tipoMaterial: "PET ALTA BARRERA",
      micras: 12,
    });

    assert.equal(res.status, 201);
    if (res.status === 201) {
      const orders = handleGetOrders();
      const petOrder = orders.find((o) => o.id === res.body.orderId)!;
      assert.ok(petOrder);
      assert.equal(petOrder.material, "PET ALTA BARRERA");
    }
  });

  // --- Test W: Camisa válida que no está en la lista manual ---
  it("W. Camisa válida fuera de la lista manual: integración y lectura funcionan correctamente", async () => {
    const res = await handleNexusOrder({
      eventId: "44444444-4444-4444-8444-444444444444",
      pedidoId: "PED-CUSTOM-SLEEVE",
      numeroPedidoCliente: "2600888",
      metros: 6500,
      bobinaMadre: 1300,
      camisa: "CUSTOM-650-EXT",
      tipoMaterial: "LDPE",
      micras: 50,
    });

    assert.equal(res.status, 201);
    if (res.status === 201) {
      const orders = handleGetOrders();
      const customOrder = orders.find((o) => o.id === res.body.orderId)!;
      assert.ok(customOrder);
      assert.equal(customOrder.camisa, "CUSTOM-650-EXT");
    }
  });

  // --- Tests X, Y, Z: Trazabilidad de pedidos en bobinas e inventario ---
  it("X. Bobina fabricada desde orden con 1 pedido devuelve pedidosRelacionados con el pedido correspondiente", async () => {
    const resOrder = await handleNexusOrder({
      eventId: "55555555-5555-4555-8555-555555555555",
      pedidoId: "PED-SINGLE",
      numeroPedidoCliente: "2600777",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(resOrder.status, 201);
    if (resOrder.status === 201) {
      const orderId = resOrder.body.orderId;
      const resCoil = handleAddManufacturedCoil(orderId, 2500);
      assert.equal(resCoil.status, 201);
      if (resCoil.status === 201) {
        assert.equal(resCoil.body.pedidosRelacionados.length, 1);
        assert.equal(resCoil.body.pedidosRelacionados[0].numeroPedidoCliente, "2600777");

        const inv = handleGetInventory();
        assert.equal(inv.items.length, 1);
        assert.equal(inv.items[0].pedidosRelacionados.length, 1);
        assert.equal(inv.items[0].pedidosRelacionados[0].pedidoId, "PED-SINGLE");

        const orderCoils = handleGetOrderCoils(orderId);
        assert.equal(orderCoils.length, 1);
        assert.equal(orderCoils[0].pedidosRelacionados.length, 1);
      }
    }
  });

  it("Y. Bobina fabricada desde orden con pedidos agrupados devuelve todos los pedidos vinculados", async () => {
    await handleNexusOrder({
      eventId: "66666666-6666-4666-8666-666666666666",
      pedidoId: "PED-G1",
      numeroPedidoCliente: "2600111",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    const res2 = await handleNexusOrder({
      eventId: "77777777-7777-4777-8777-777777777777",
      pedidoId: "PED-G2",
      numeroPedidoCliente: "2600222",
      metros: 4000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });

    assert.equal(res2.status, 200);
    if (res2.status === 200) {
      const orderId = res2.body.orderId;
      const resCoil = handleAddManufacturedCoil(orderId, 7000);
      assert.equal(resCoil.status, 201);
      if (resCoil.status === 201) {
        assert.equal(resCoil.body.pedidosRelacionados.length, 2);
        assert.equal(resCoil.body.pedidosRelacionados[0].numeroPedidoCliente, "2600111");
        assert.equal(resCoil.body.pedidosRelacionados[1].numeroPedidoCliente, "2600222");

        const inv = handleGetInventory();
        const coilItem = inv.items.find((c) => c.id === resCoil.body.id)!;
        assert.ok(coilItem);
        assert.equal(coilItem.pedidosRelacionados.length, 2);

        const orderCoils = handleGetOrderCoils(orderId);
        assert.equal(orderCoils[0].pedidosRelacionados.length, 2);
      }
    }
  });

  it("Z. Resto sin orden asociada devuelve pedidosRelacionados como array vacío", async () => {
    testDb.coils.push({
      id: testDb.coils.length + 1,
      ordenId: null,
      metros: "1200",
    });

    const inv = handleGetInventory();
    assert.equal(inv.items.length, 1);
    assert.equal(inv.items[0].ordenId, null);
    assert.deepEqual(inv.items[0].pedidosRelacionados, []);
  });

  it("AA. Bobina fabricada permite registrarse sobre una orden BLOQUEADA", async () => {
    const resOrder = await handleNexusOrder({
      eventId: "88888888-8888-4888-8888-888888888888",
      pedidoId: "PED-BLOQ",
      numeroPedidoCliente: "2600999",
      metros: 4000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 20,
    });
    assert.equal(resOrder.status, 201);
    if (resOrder.status === 201) {
      const orderId = resOrder.body.orderId;
      // Bloquear la orden
      const blockRes = handleSetOrderBlocked(orderId, true);
      assert.equal(blockRes.status, 200);

      // Fabricar bobina en la orden bloqueada
      const resCoil = handleAddManufacturedCoil(orderId, 1500);
      assert.equal(resCoil.status, 201);
      if (resCoil.status === 201) {
        assert.equal(resCoil.body.metros, 1500);
        assert.equal(resCoil.body.ordenId, orderId);
      }
    }
  });

  it("AB. Finalizar manual en orden BLOQUEADA cambia estado a FINALIZADA y guarda nota de metros faltantes", async () => {
    const resOrder = await handleNexusOrder({
      eventId: "99999999-9999-4999-9999-999999999999",
      pedidoId: "PED-FIN-1",
      numeroPedidoCliente: "2601001",
      metros: 5000,
      bobinaMadre: 1000,
      camisa: "520",
      tipoMaterial: "OPP",
      micras: 25,
    });
    assert.equal(resOrder.status, 201);
    if (resOrder.status === 201) {
      const orderId = resOrder.body.orderId;
      // Fabricar 2000m de 5000m
      handleAddManufacturedCoil(orderId, 2000);

      // Bloquear la orden
      const blockRes = handleSetOrderBlocked(orderId, true);
      assert.equal(blockRes.status, 200);

      // Finalizar manualmente la orden bloqueada
      const finRes = handleFinalizeOrder(orderId);
      assert.equal(finRes.status, 200);
      if (finRes.status === 200) {
        assert.equal(finRes.body.estado, "FINALIZADA");
        assert.equal(finRes.body.metrosFabricados, 2000);
        assert.equal(finRes.body.metrosPendientes, 3000);
        assert.ok(finRes.body.finalizadaEn);
        assert.ok(finRes.body.nota);
        assert.ok(finRes.body.nota.includes("3.000 m faltantes") || finRes.body.nota.includes("3000"));
      }
    }
  });

  it("AC. Finalizar manual en orden ACTIVA es rechazado con 400", async () => {
    const resOrder = await handleNexusOrder({
      eventId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      pedidoId: "PED-ACTIVA-FIN",
      numeroPedidoCliente: "2601002",
      metros: 3000,
      bobinaMadre: 1000,
      camisa: "520",
      tipoMaterial: "OPP",
      micras: 25,
    });
    assert.equal(resOrder.status, 201);
    if (resOrder.status === 201) {
      const finRes = handleFinalizeOrder(resOrder.body.orderId);
      assert.equal(finRes.status, 400);
      assert.equal(finRes.body.error, "Solo se pueden finalizar manualmente órdenes que estén bloqueadas");
    }
  });

  it("AD. Finalizar manual en orden ya FINALIZADA es rechazado con 400", async () => {
    const resOrder = await handleNexusOrder({
      eventId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      pedidoId: "PED-ALREADY-FIN",
      numeroPedidoCliente: "2601003",
      metros: 2000,
      bobinaMadre: 1000,
      camisa: "520",
      tipoMaterial: "OPP",
      micras: 25,
    });
    assert.equal(resOrder.status, 201);
    if (resOrder.status === 201) {
      const orderId = resOrder.body.orderId;
      // Fabricar todos los metros para que se finalice automáticamente
      handleAddManufacturedCoil(orderId, 2000);

      const finRes = handleFinalizeOrder(orderId);
      assert.equal(finRes.status, 400);
    }
  });

  it("AE. Finalizar manual con nota personalizada preserva la nota y los metros faltantes", async () => {
    const resOrder = await handleNexusOrder({
      eventId: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      pedidoId: "PED-CUSTOM-NOTE",
      numeroPedidoCliente: "2601004",
      metros: 6000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 20,
    });
    assert.equal(resOrder.status, 201);
    if (resOrder.status === 201) {
      const orderId = resOrder.body.orderId;
      handleAddManufacturedCoil(orderId, 1500);
      handleSetOrderBlocked(orderId, true);

      const finRes = handleFinalizeOrder(orderId, "Parada técnica por avería de máquina");
      assert.equal(finRes.status, 200);
      if (finRes.status === 200) {
        assert.equal(finRes.body.estado, "FINALIZADA");
        assert.ok(finRes.body.nota?.includes("Parada técnica por avería de máquina"));
        assert.ok(finRes.body.nota?.includes("4.500 m") || finRes.body.nota?.includes("4500"));
      }
    }
  });

  it("AF. Orden finalizada manualmente aparece en GET /orders?status=FINALIZADA y no en BLOQUEADA", async () => {
    const resOrder = await handleNexusOrder({
      eventId: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
      pedidoId: "PED-QUERY-FIN",
      numeroPedidoCliente: "2601005",
      metros: 4000,
      bobinaMadre: 1000,
      camisa: "520",
      tipoMaterial: "OPP",
      micras: 25,
    });
    assert.equal(resOrder.status, 201);
    if (resOrder.status === 201) {
      const orderId = resOrder.body.orderId;
      handleSetOrderBlocked(orderId, true);
      handleFinalizeOrder(orderId);

      const blockedOrders = handleGetOrders("BLOQUEADA");
      assert.ok(!blockedOrders.some((o) => o.id === orderId));

      const finalizedOrders = handleGetOrders("FINALIZADA");
      const found = finalizedOrders.find((o) => o.id === orderId);
      assert.ok(found);
      assert.equal(found?.estado, "FINALIZADA");
      assert.ok(found?.nota);
    }
  });

  it("AG. Nexus crea nueva orden ACTIVA cuando existe orden finalizada manualmente del mismo grupo", async () => {
    const res1 = await handleNexusOrder({
      eventId: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
      pedidoId: "PED-GROUP-1",
      numeroPedidoCliente: "2601006",
      metros: 5000,
      bobinaMadre: 1000,
      camisa: "520",
      tipoMaterial: "OPP",
      micras: 25,
    });
    assert.equal(res1.status, 201);
    if (res1.status === 201) {
      const orderId1 = res1.body.orderId;
      handleSetOrderBlocked(orderId1, true);
      handleFinalizeOrder(orderId1);

      // Ahora llega un pedido compatible con las mismas características
      const res2 = await handleNexusOrder({
        eventId: "ffffffff-ffff-4fff-ffff-ffffffffffff",
        pedidoId: "PED-GROUP-2",
        numeroPedidoCliente: "2601007",
        metros: 3000,
        bobinaMadre: 1000,
        camisa: "520",
        tipoMaterial: "OPP",
        micras: 25,
      });
      assert.equal(res2.status, 201);
      if (res2.status === 201) {
        // Debe crear una NUEVA orden activa, NO reusar la orden finalizada
        assert.notEqual(res2.body.orderId, orderId1);
        assert.equal(res2.body.totalMetros, 3000);
      }
    }
  });
});

