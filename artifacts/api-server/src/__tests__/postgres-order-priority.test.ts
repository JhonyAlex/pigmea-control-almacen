import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:test@localhost:5439/control_bobinas_priority_test";
process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN =
  "test-secret-nexus-token-xyz-123456";

const { Pool, Client } = pg;
const TEST_TOKEN = process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN;

/**
 * La posición de una orden dentro de su lista depende de dos cosas y de nada
 * más: la prioridad que fija un administrador a mano, y el hecho de ser nueva,
 * en cuyo caso entra al final de las activas. Nada automático la mueve.
 */
describe("Prioridad manual de órdenes contra PostgreSQL real", () => {
  let adminClient: pg.Client;
  let pool: pg.Pool;
  let server: http.Server;
  let baseUrl: string;
  let sessionCookie: string;

  const insertOrder = async (
    overrides: Partial<{
      ancho: string;
      micras: string;
      camisa: string;
      material: string;
      estado: string;
      origen: string;
      orden: number;
    }> = {},
  ): Promise<number> => {
    const values = {
      ancho: "1200.00",
      micras: "30.00",
      camisa: "400",
      material: "OPP",
      estado: "ACTIVA",
      origen: "MANUAL",
      orden: 0,
      ...overrides,
    };
    const res = await pool.query(
      `INSERT INTO production_orders
         (ancho, micras, camisa, material, metros_necesarios, estado, origen, orden)
       VALUES ($1,$2,$3,$4,'5000.00',$5,$6,$7) RETURNING id`,
      [
        values.ancho,
        values.micras,
        values.camisa,
        values.material,
        values.estado,
        values.origen,
        values.orden,
      ],
    );
    return res.rows[0].id as number;
  };

  /** Ids de una lista en el mismo orden en que los devuelve la API. */
  const listIds = async (estado: string): Promise<number[]> => {
    const res = await fetch(`${baseUrl}/api/orders?status=${estado}`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: number }>;
    return body.map((order) => order.id);
  };

  const reorder = async (estado: string | undefined, orderIds: number[]) => {
    const res = await fetch(`${baseUrl}/api/orders/reorder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify(estado ? { estado, orderIds } : { orderIds }),
    });
    return res.status;
  };

  const createOrder = async (ancho: number): Promise<number> => {
    const res = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({
        ancho,
        micras: 30,
        camisa: 400,
        material: "OPP",
        metrosNecesarios: 5000,
      }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: number }).id;
  };

  const sendNexus = async (payload: Record<string, unknown>) => {
    const response = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payload),
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };

  const nexusPayload = (overrides: Record<string, unknown> = {}) => ({
    eventId: "d0000000-0000-4000-8000-000000000001",
    pedidoId: "PED-PRIO-1",
    numeroPedidoCliente: "PRIO-1",
    metros: 1000,
    bobinaMadre: 1200,
    camisa: "400",
    tipoMaterial: "OPP",
    micras: 30,
    ...overrides,
  });

  before(async () => {
    adminClient = new Client({
      connectionString: "postgresql://postgres:test@localhost:5439/postgres",
    });
    await adminClient.connect();
    await adminClient.query(
      "DROP DATABASE IF EXISTS control_bobinas_priority_test",
    );
    await adminClient.query("CREATE DATABASE control_bobinas_priority_test");

    const dbModule = await import("@workspace/db");
    pool = dbModule.pool;

    const { fileURLToPath } = await import("node:url");
    const migrationsFolder = fileURLToPath(
      new URL("../../../../lib/db/drizzle", import.meta.url),
    );
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(dbModule.db, { migrationsFolder });

    const appModule = await import("../app");
    const app = appModule.default;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const regRes = await fetch(`${baseUrl}/api/auth/register-first`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: "Admin Pigmea",
        email: "admin@pigmea.test",
        password: "SuperSecretPassword123!",
      }),
    });
    sessionCookie = (regRes.headers.get("set-cookie") || "").split(";")[0];
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (pool) await pool.end();
    if (adminClient) {
      await adminClient.query(
        "DROP DATABASE IF EXISTS control_bobinas_priority_test",
      );
      await adminClient.end();
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE production_order_coil_assignments, production_order_pedidos, coils, production_orders RESTART IDENTITY CASCADE",
    );
  });

  // =========================================================================
  // REGLA 1: UNA ORDEN NUEVA ENTRA AL FINAL
  // =========================================================================

  it("P1. Las órdenes creadas a mano se encolan al final, por antigüedad", async () => {
    const first = await createOrder(1200);
    const second = await createOrder(1250);
    const third = await createOrder(1300);

    assert.deepEqual(await listIds("ACTIVA"), [first, second, third]);
  });

  it("P2. Una orden nueva entra al final aunque ya se haya reordenado a mano", async () => {
    const a = await createOrder(1200);
    const b = await createOrder(1250);
    assert.equal(await reorder("ACTIVA", [b, a]), 204);
    assert.deepEqual(await listIds("ACTIVA"), [b, a]);

    const c = await createOrder(1300);
    assert.deepEqual(await listIds("ACTIVA"), [b, a, c]);
  });

  it("P3. Una orden nueva de Gestión Pedidos entra al final de las activas", async () => {
    const manual = await createOrder(1200);
    const nexus = await sendNexus(nexusPayload());
    assert.equal(nexus.status, 201);

    assert.deepEqual(await listIds("ACTIVA"), [manual, nexus.body.orderId]);
  });

  it("P4. Agrupar un pedido en una orden existente no la mueve de sitio", async () => {
    const created = await sendNexus(nexusPayload());
    assert.equal(created.status, 201);
    const below = await createOrder(1500);
    assert.deepEqual(await listIds("ACTIVA"), [created.body.orderId, below]);

    // La orden de Nexus se baja a mano al último puesto.
    assert.equal(await reorder("ACTIVA", [below, created.body.orderId]), 204);
    assert.deepEqual(await listIds("ACTIVA"), [below, created.body.orderId]);

    const grouped = await sendNexus(
      nexusPayload({
        eventId: "d0000000-0000-4000-8000-000000000002",
        pedidoId: "PED-PRIO-2",
        numeroPedidoCliente: "PRIO-2",
      }),
    );
    assert.equal(grouped.status, 200);
    assert.equal(grouped.body.action, "ORDER_UPDATED");
    assert.equal(grouped.body.orderId, created.body.orderId);

    // Sumó metros pero no recuperó la cabeza de la lista.
    assert.equal(grouped.body.totalMetros, 2000);
    assert.deepEqual(await listIds("ACTIVA"), [below, created.body.orderId]);
  });

  // =========================================================================
  // REGLA 2: PRIORIDAD MANUAL, TAMBIÉN EN BLOQUEADAS
  // =========================================================================

  it("P5. Las órdenes bloqueadas se reordenan a mano igual que las activas", async () => {
    const x = await insertOrder({ estado: "BLOQUEADA", orden: 0 });
    const y = await insertOrder({ estado: "BLOQUEADA", orden: 1 });
    const z = await insertOrder({ estado: "BLOQUEADA", orden: 2 });
    assert.deepEqual(await listIds("BLOQUEADA"), [x, y, z]);

    assert.equal(await reorder("BLOQUEADA", [z, x, y]), 204);
    assert.deepEqual(await listIds("BLOQUEADA"), [z, x, y]);
  });

  it("P6. Reordenar una lista no altera el orden de la otra", async () => {
    const a = await insertOrder({ estado: "ACTIVA", orden: 0 });
    const x = await insertOrder({ estado: "BLOQUEADA", orden: 1 });
    const b = await insertOrder({ estado: "ACTIVA", orden: 2 });
    const y = await insertOrder({ estado: "BLOQUEADA", orden: 3 });
    const c = await insertOrder({ estado: "ACTIVA", orden: 4 });

    assert.deepEqual(await listIds("ACTIVA"), [a, b, c]);
    assert.deepEqual(await listIds("BLOQUEADA"), [x, y]);

    assert.equal(await reorder("ACTIVA", [c, a, b]), 204);
    assert.deepEqual(await listIds("ACTIVA"), [c, a, b]);
    assert.deepEqual(await listIds("BLOQUEADA"), [x, y]);

    assert.equal(await reorder("BLOQUEADA", [y, x]), 204);
    assert.deepEqual(await listIds("BLOQUEADA"), [y, x]);
    assert.deepEqual(await listIds("ACTIVA"), [c, a, b]);
  });

  it("P7. Reordenar deja la secuencia sin posiciones repetidas", async () => {
    const a = await insertOrder({ estado: "ACTIVA", orden: 7 });
    const b = await insertOrder({ estado: "ACTIVA", orden: 7 });
    const x = await insertOrder({ estado: "BLOQUEADA", orden: 7 });

    assert.equal(await reorder("ACTIVA", [b, a]), 204);

    const rows = await pool.query(
      "SELECT orden FROM production_orders WHERE id = ANY($1)",
      [[a, b, x]],
    );
    const positions = rows.rows.map((row) => row.orden);
    assert.equal(new Set(positions).size, positions.length);
  });

  it("P8. Sin estado explícito se reordenan las activas (compatibilidad)", async () => {
    const a = await createOrder(1200);
    const b = await createOrder(1250);

    assert.equal(await reorder(undefined, [b, a]), 204);
    assert.deepEqual(await listIds("ACTIVA"), [b, a]);
  });

  it("P9. Una lista incompleta o de otro estado se rechaza con 409", async () => {
    const a = await createOrder(1200);
    const b = await createOrder(1250);
    const blocked = await insertOrder({ estado: "BLOQUEADA", orden: 9 });

    assert.equal(await reorder("ACTIVA", [a]), 409);
    assert.equal(await reorder("ACTIVA", [a, b, blocked]), 409);
    assert.equal(await reorder("BLOQUEADA", [a, blocked]), 409);
    assert.deepEqual(await listIds("ACTIVA"), [a, b]);
  });
});
