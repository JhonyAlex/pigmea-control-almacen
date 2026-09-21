import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:test@localhost:5439/control_bobinas_real_nexus_test";
process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN =
  "test-secret-nexus-token-xyz-123456";

const { Pool, Client } = pg;
const TEST_DB_URL = process.env.DATABASE_URL;
const TEST_TOKEN = "test-secret-nexus-token-xyz-123456";

describe("Validación Integral contra PostgreSQL y Express Reales", () => {
  let adminClient: pg.Client;
  let pool: pg.Pool;
  let db: any;
  let schema: any;
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    // 1. Prepare isolated test database
    adminClient = new Client({
      connectionString: "postgresql://postgres:test@localhost:5439/postgres",
    });
    await adminClient.connect();
    await adminClient.query(
      "DROP DATABASE IF EXISTS control_bobinas_real_nexus_test",
    );
    await adminClient.query("CREATE DATABASE control_bobinas_real_nexus_test");

    // 2. Set environment variables for the application
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN = TEST_TOKEN;

    const dbModule = await import("@workspace/db");
    const schemaModule = await import("@workspace/db/schema");
    schema = schemaModule;
    pool = dbModule.pool;
    db = dbModule.db;

    // 3. Apply all migrations from 0000 to 0002
    const { fileURLToPath } = await import("node:url");
    const migrationsFolder = fileURLToPath(
      new URL("../../../../lib/db/drizzle", import.meta.url),
    );
    await migrate(db, { migrationsFolder });

    // 4. Start real Express HTTP server on ephemeral port
    const appModule = await import("../app");
    const app = appModule.default;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (pool) {
      await pool.end();
    }
    if (adminClient) {
      await adminClient.query(
        "DROP DATABASE IF EXISTS control_bobinas_real_nexus_test",
      );
      await adminClient.end();
    }
  });

  beforeEach(async () => {
    // Clean tables between tests
    await pool.query(
      "TRUNCATE TABLE production_order_pedidos, coils, production_orders, auth_sessions, users RESTART IDENTITY CASCADE",
    );
  });

  // ==========================================================================
  // SECCIÓN 6: TESTS POSTGRESQL REALES OBLIGATORIOS
  // ==========================================================================

  it("6A. Primer pedido: Crea orden GESTION_PEDIDOS real en PostgreSQL", async () => {
    const payload = {
      eventId: "a0000000-0000-4000-8000-000000000001",
      pedidoId: "PED-2026-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const res = await fetch(
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

    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.equal(body.action, "ORDER_CREATED");
    assert.equal(body.totalMetros, 5000);

    // Direct PostgreSQL query verification
    const orderRes = await pool.query(
      `SELECT * FROM production_orders WHERE id = $1`,
      [body.orderId],
    );
    assert.equal(orderRes.rows.length, 1);
    assert.equal(orderRes.rows[0].origen, "GESTION_PEDIDOS");
    assert.equal(orderRes.rows[0].estado, "ACTIVA");
    assert.equal(Number(orderRes.rows[0].metros_necesarios), 5000);

    const relRes = await pool.query(
      `SELECT * FROM production_order_pedidos WHERE orden_id = $1`,
      [body.orderId],
    );
    assert.equal(relRes.rows.length, 1);
    assert.equal(relRes.rows[0].event_id, payload.eventId);
    assert.equal(relRes.rows[0].pedido_id, "PED-2026-001");
  });

  it("6B & 6C. Segundo pedido compatible: Reutiliza la MISMA orden y SUM(metros) exacto en SQL", async () => {
    const payload1 = {
      eventId: "a0000000-0000-4000-8000-000000000001",
      pedidoId: "PED-2026-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };
    const payload2 = {
      eventId: "b0000000-0000-4000-8000-000000000002",
      pedidoId: "PED-2026-002",
      numeroPedidoCliente: "2600102",
      metros: 7000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const res1 = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payload1),
      },
    );
    const body1 = (await res1.json()) as any;

    const res2 = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payload2),
      },
    );
    const body2 = (await res2.json()) as any;

    assert.equal(res2.status, 200);
    assert.equal(body2.action, "ORDER_UPDATED");
    assert.equal(body2.orderId, body1.orderId);
    assert.equal(body2.totalMetros, 12000);

    // Verify PostgreSQL state
    const orderRes = await pool.query(`SELECT * FROM production_orders`);
    assert.equal(orderRes.rows.length, 1);
    assert.equal(Number(orderRes.rows[0].metros_necesarios), 12000);

    const relRes = await pool.query(
      `SELECT * FROM production_order_pedidos ORDER BY vinculado_en ASC`,
    );
    assert.equal(relRes.rows.length, 2);
  });

  it("6C2. Una orden nueva entra al final de las activas y agrupar no mueve a nadie", async () => {
    const blocked = await pool.query(`
      INSERT INTO production_orders
        (ancho, micras, camisa, material, metros_necesarios, estado, origen, orden)
      VALUES ('900.00', '20.00', '300', 'PE', '1000.00', 'BLOQUEADA', 'MANUAL', -100)
      RETURNING id, orden
    `);
    const sendNexus = async (payload: Record<string, unknown>) => {
      const response = await fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify(payload),
      });
      return { response, body: (await response.json()) as any };
    };
    const payloadA = {
      eventId: "c1000000-0000-4000-8000-000000000001",
      pedidoId: "PED-PRIORITY-A1",
      numeroPedidoCliente: "PRIORITY-A1",
      metros: 1000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const orderA = await sendNexus(payloadA);
    const orderB = await sendNexus({
      ...payloadA,
      eventId: "c2000000-0000-4000-8000-000000000002",
      pedidoId: "PED-PRIORITY-B1",
      numeroPedidoCliente: "PRIORITY-B1",
      bobinaMadre: 1300,
    });
    assert.equal(orderA.response.status, 201);
    assert.equal(orderB.response.status, 201);

    // Cada orden nueva se coloca por debajo de todo lo ya encolado: A antes
    // que B porque entró antes, y ambas por debajo de la bloqueada (-100).
    const beforeGrouping = await pool.query(
      `SELECT id, orden FROM production_orders ORDER BY id`,
    );
    const ordenOf = (rows: any[], id: number) =>
      rows.find((row) => row.id === id).orden;
    const ordenA = ordenOf(beforeGrouping.rows, orderA.body.orderId);
    const ordenB = ordenOf(beforeGrouping.rows, orderB.body.orderId);
    assert.ok(ordenA < ordenB, "la orden creada después queda por debajo");
    assert.equal(ordenOf(beforeGrouping.rows, blocked.rows[0].id), -100);

    const grouped = await sendNexus({
      ...payloadA,
      eventId: "c3000000-0000-4000-8000-000000000003",
      pedidoId: "PED-PRIORITY-A2",
      numeroPedidoCliente: "PRIORITY-A2",
    });
    assert.equal(grouped.response.status, 200);
    assert.equal(grouped.body.action, "ORDER_UPDATED");

    // Agrupar sólo suma metros: ni la orden agrupada ni el resto se mueven.
    const afterGrouping = await pool.query(
      `SELECT id, orden FROM production_orders ORDER BY id`,
    );
    assert.equal(ordenOf(afterGrouping.rows, orderA.body.orderId), ordenA);
    assert.equal(ordenOf(afterGrouping.rows, orderB.body.orderId), ordenB);
    assert.equal(ordenOf(afterGrouping.rows, blocked.rows[0].id), -100);

    const activeOrders = await pool.query(
      `SELECT id FROM production_orders WHERE estado = 'ACTIVA' ORDER BY orden ASC, id ASC`,
    );
    assert.deepEqual(
      activeOrders.rows.map((order) => order.id),
      [orderA.body.orderId, orderB.body.orderId],
    );
  });

  it("6D. UNIQUE(event_id) en PostgreSQL: Impide físicamente duplicar event_id", async () => {
    // Insert order directly
    const oRes = await pool.query(`
      INSERT INTO production_orders (ancho, micras, camisa, material, metros_necesarios, estado, origen)
      VALUES ('1200.00', '30.00', '400', 'OPP', '5000.00', 'ACTIVA', 'GESTION_PEDIDOS')
      RETURNING id
    `);
    const orderId = oRes.rows[0].id;
    const eventId = "e0000000-0000-4000-8000-000000000099";

    // First relation insert succeeds
    await pool.query(
      `
      INSERT INTO production_order_pedidos (orden_id, event_id, pedido_id, numero_pedido_cliente, metros)
      VALUES ($1, $2, 'PED-1', '26001', '5000.00')
    `,
      [orderId, eventId],
    );

    // Second relation with same event_id must fail with 23505 unique constraint violation
    await assert.rejects(
      async () => {
        await pool.query(
          `
          INSERT INTO production_order_pedidos (orden_id, event_id, pedido_id, numero_pedido_cliente, metros)
          VALUES ($1, $2, 'PED-2', '26002', '3000.00')
        `,
          [orderId, eventId],
        );
      },
      (err: any) => err.code === "23505",
      "PostgreSQL enforces UNIQUE(event_id)",
    );
  });

  it("6E. Idempotencia: Mismo eventId y mismo payload retorna 200 ALREADY_PROCESSED sin sumar metros", async () => {
    const payload = {
      eventId: "e0000000-0000-4000-8000-000000000001",
      pedidoId: "PED-2026-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const res1 = await fetch(
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
    const body1 = (await res1.json()) as any;
    assert.equal(res1.status, 201);

    const res2 = await fetch(
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
    const body2 = (await res2.json()) as any;

    assert.equal(res2.status, 200);
    assert.equal(body2.action, "ALREADY_PROCESSED");
    assert.equal(body2.orderId, body1.orderId);
    assert.equal(body2.totalMetros, 5000);

    const relCount = await pool.query(
      `SELECT COUNT(*) as count FROM production_order_pedidos`,
    );
    assert.equal(Number(relCount.rows[0].count), 1);
  });

  it("6F. Idempotencia: Mismo eventId con payload diferente retorna 409 IDEMPOTENCY_CONFLICT", async () => {
    const eventId = "e0000000-0000-4000-8000-000000000001";
    const payload1 = {
      eventId,
      pedidoId: "PED-2026-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    await fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(payload1),
    });

    const payload2 = {
      eventId,
      pedidoId: "PED-2026-002", // Different pedidoId
      numeroPedidoCliente: "2600102",
      metros: 9000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const resConflict = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payload2),
      },
    );

    assert.equal(resConflict.status, 409);
    const bodyConflict = (await resConflict.json()) as any;
    assert.equal(bodyConflict.code, "IDEMPOTENCY_CONFLICT");

    // Verify DB unchanged
    const orderRes = await pool.query(`SELECT * FROM production_orders`);
    assert.equal(Number(orderRes.rows[0].metros_necesarios), 5000);
  });

  it("6G. Índice único parcial: Bloquea físicamente dos órdenes ACTIVA GESTION_PEDIDOS del mismo grupo", async () => {
    await pool.query(`
      INSERT INTO production_orders (ancho, micras, camisa, material, metros_necesarios, estado, origen)
      VALUES ('1200.00', '30.00', '400', 'OPP', '5000.00', 'ACTIVA', 'GESTION_PEDIDOS')
    `);

    // Direct insert of duplicate compatible active order in PostgreSQL must violate partial unique index
    await assert.rejects(
      async () => {
        await pool.query(`
          INSERT INTO production_orders (ancho, micras, camisa, material, metros_necesarios, estado, origen)
          VALUES ('1200.00', '30.00', '400', ' opp ', '3000.00', 'ACTIVA', 'GESTION_PEDIDOS')
        `);
      },
      (err: any) => {
        return (
          err.code === "23505" &&
          err.constraint === "production_orders_gp_active_group_idx"
        );
      },
      "Partial unique index enforces at most 1 active automatic order per group",
    );
  });

  it("6H. El índice único parcial NO afecta a órdenes MANUAL compatibles", async () => {
    // Two active manual orders with identical specs are allowed
    await pool.query(`
      INSERT INTO production_orders (ancho, micras, camisa, material, metros_necesarios, estado, origen)
      VALUES
        ('1200.00', '30.00', '400', 'OPP', '5000.00', 'ACTIVA', 'MANUAL'),
        ('1200.00', '30.00', '400', 'OPP', '3000.00', 'ACTIVA', 'MANUAL')
    `);

    const count = await pool.query(
      `SELECT COUNT(*) as count FROM production_orders`,
    );
    assert.equal(Number(count.rows[0].count), 2);
  });

  it("6I. El índice único parcial permite 1 BLOQUEADA + 1 ACTIVA automática", async () => {
    await pool.query(`
      INSERT INTO production_orders (ancho, micras, camisa, material, metros_necesarios, estado, origen)
      VALUES
        ('1200.00', '30.00', '400', 'OPP', '5000.00', 'BLOQUEADA', 'GESTION_PEDIDOS'),
        ('1200.00', '30.00', '400', 'OPP', '3000.00', 'ACTIVA', 'GESTION_PEDIDOS')
    `);

    const count = await pool.query(
      `SELECT COUNT(*) as count FROM production_orders`,
    );
    assert.equal(Number(count.rows[0].count), 2);
  });

  it("6J. Normalización case y espacios: 'OPP Reciclado', ' opp reciclado ' y 'OPP RECICLADO' se agrupan juntos", async () => {
    const payload1 = {
      eventId: "a0000000-0000-4000-8000-000000000001",
      pedidoId: "PED-1",
      numeroPedidoCliente: "26001",
      metros: 2000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP Reciclado",
      micras: 30,
    };
    const payload2 = {
      eventId: "b0000000-0000-4000-8000-000000000002",
      pedidoId: "PED-2",
      numeroPedidoCliente: "26002",
      metros: 3000,
      bobinaMadre: 1200,
      camisa: " 400 ",
      tipoMaterial: " opp reciclado ",
      micras: 30,
    };
    const payload3 = {
      eventId: "c0000000-0000-4000-8000-000000000003",
      pedidoId: "PED-3",
      numeroPedidoCliente: "26003",
      metros: 4000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP RECICLADO",
      micras: 30,
    };

    await fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(payload1),
    });
    await fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(payload2),
    });
    const res3 = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payload3),
      },
    );
    const body3 = (await res3.json()) as any;

    assert.equal(body3.totalMetros, 9000);
    const orders = await pool.query(`SELECT * FROM production_orders`);
    assert.equal(
      orders.rows.length,
      1,
      "All 3 orders merged into exact 1 order",
    );
    assert.equal(Number(orders.rows[0].metros_necesarios), 9000);
  });

  it("6K. NUMERIC decimal precision: 1000.10 + 2000.20 = 3000.30 sin drift de floating point", async () => {
    const payload1 = {
      eventId: "a0000000-0000-4000-8000-000000000001",
      pedidoId: "PED-1",
      numeroPedidoCliente: "26001",
      metros: 1000.1,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };
    const payload2 = {
      eventId: "b0000000-0000-4000-8000-000000000002",
      pedidoId: "PED-2",
      numeroPedidoCliente: "26002",
      metros: 2000.2,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    await fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(payload1),
    });
    const res2 = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payload2),
      },
    );
    const body2 = (await res2.json()) as any;

    assert.equal(body2.totalMetros, 3000.3);

    const orderRes = await pool.query(
      `SELECT metros_necesarios FROM production_orders`,
    );
    assert.equal(orderRes.rows[0].metros_necesarios, "3000.30");
  });

  // ==========================================================================
  // SECCIÓN 7: CONCURRENCIA REAL
  // ==========================================================================

  it("7. Concurrencia Real: 2 requests concurrentes HTTP sobre PostgreSQL producen 1 orden, 2 relaciones y 12000m", async () => {
    const payloadA = {
      eventId: "11111111-aaaa-4111-8111-111111111111",
      pedidoId: "PED-CONC-A",
      numeroPedidoCliente: "2600901",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    const payloadB = {
      eventId: "22222222-bbbb-4222-8222-222222222222",
      pedidoId: "PED-CONC-B",
      numeroPedidoCliente: "2600902",
      metros: 7000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    };

    // Execute concurrently using parallel fetch requests over the network
    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payloadA),
      }),
      fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(payloadB),
      }),
    ]);

    assert.ok(
      resA.status === 200 || resA.status === 201,
      `resA status was ${resA.status}`,
    );
    assert.ok(
      resB.status === 200 || resB.status === 201,
      `resB status was ${resB.status}`,
    );

    const [bodyA, bodyB] = await Promise.all([
      resA.json() as Promise<any>,
      resB.json() as Promise<any>,
    ]);

    // One must be created and the other updated
    const actions = [bodyA.action, bodyB.action].sort();
    assert.deepEqual(actions, ["ORDER_CREATED", "ORDER_UPDATED"]);

    // Verify DB integrity
    const ordersRes = await pool.query(
      `SELECT * FROM production_orders WHERE estado = 'ACTIVA' AND origen = 'GESTION_PEDIDOS'`,
    );
    assert.equal(
      ordersRes.rows.length,
      1,
      "Exactly 1 active GESTION_PEDIDOS order",
    );
    assert.equal(
      Number(ordersRes.rows[0].metros_necesarios),
      12000,
      "Exact total is 12000.00",
    );

    const relsRes = await pool.query(
      `SELECT * FROM production_order_pedidos WHERE orden_id = $1`,
      [ordersRes.rows[0].id],
    );
    assert.equal(relsRes.rows.length, 2, "Exactly 2 relation rows in database");
  });

  // ==========================================================================
  // SECCIÓN 8: CARRERA INTEGRACIÓN VS DESBLOQUEO
  // ==========================================================================

  it("8. Carrera Integración vs Desbloqueo: Invariante preservada sin 500 no controlado", async () => {
    // 1. Setup user session via official registration endpoint to get real cookie
    const regRes = await fetch(`${baseUrl}/api/auth/register-first`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: "Admin Pigmea",
        email: "admin@pigmea.test",
        password: "SuperSecretPassword123!",
      }),
    });
    const setCookie = regRes.headers.get("set-cookie") || "";
    const sessionCookie = setCookie.split(";")[0];

    // 2. Initial state: Order A is GESTION_PEDIDOS, BLOQUEADA
    const oRes = await pool.query(`
      INSERT INTO production_orders (ancho, micras, camisa, material, metros_necesarios, estado, origen)
      VALUES ('1200.00', '30.00', '400', 'OPP', '5000.00', 'BLOQUEADA', 'GESTION_PEDIDOS')
      RETURNING id
    `);
    const orderAId = oRes.rows[0].id;

    // 3. Concurrently:
    // Op 1: User tries to unblock Order A
    // Op 2: Integration sends new order for same group
    const [resUnblock, resIntegration] = await Promise.all([
      fetch(`${baseUrl}/api/orders/${orderAId}/blocked`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({ blocked: false }),
      }),
      fetch(`${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({
          eventId: "33333333-3333-4333-8333-333333333333",
          pedidoId: "PED-RACE",
          numeroPedidoCliente: "2600999",
          metros: 4000,
          bobinaMadre: 1200,
          camisa: "400",
          tipoMaterial: "OPP",
          micras: 30,
        }),
      }),
    ]);

    // Both operations must finish with valid status codes (200, 201, or controlled 409)
    // and NEVER fail with an unhandled 500 error
    assert.notEqual(
      resUnblock.status,
      500,
      `Unblock returned ${resUnblock.status}`,
    );
    assert.notEqual(
      resIntegration.status,
      500,
      `Integration returned ${resIntegration.status}`,
    );
    assert.ok(
      [200, 409].includes(resUnblock.status),
      `Unblock status was ${resUnblock.status} (expected 200 or 409)`,
    );
    assert.ok(
      [200, 201, 409].includes(resIntegration.status),
      `Integration status was ${resIntegration.status} (expected 200, 201 or 409)`,
    );

    // Verify DB invariant: Never more than 1 active GESTION_PEDIDOS order for group
    const activeOrders = await pool.query(`
      SELECT * FROM production_orders
      WHERE estado = 'ACTIVA' AND origen = 'GESTION_PEDIDOS'
    `);
    assert.ok(
      activeOrders.rows.length <= 1,
      `Invariant preserved: ${activeOrders.rows.length} active orders`,
    );
  });

  // ==========================================================================
  // SECCIÓN 9: TRANSACCIONES / ROLLBACK REAL
  // ==========================================================================

  it("9. Transacciones y Rollback: Fallo controlado revierte 100% sin filas huérfanas", async () => {
    await assert.rejects(
      async () => {
        await db.transaction(async (tx: any) => {
          const [order] = await tx
            .insert(schema.productionOrders)
            .values({
              ancho: "1200.00",
              micras: "30.00",
              camisa: "400",
              material: "OPP",
              metrosNecesarios: "5000.00",
              estado: "ACTIVA",
              origen: "GESTION_PEDIDOS",
            })
            .returning();

          await tx.insert(schema.productionOrderPedidos).values({
            ordenId: order.id,
            eventId: "99999999-9999-4999-8999-999999999999",
            pedidoId: "PED-FAIL",
            numeroPedidoCliente: "2600999",
            metros: "5000.00",
          });

          // Forced deliberate error before commit
          throw new Error("FORCED_SIMULATED_TRANSACTION_FAILURE");
        });
      },
      /FORCED_SIMULATED_TRANSACTION_FAILURE/,
      "Transaction throws forced error",
    );

    // Verify 0 rows in production_orders and production_order_pedidos
    const ordersCount = await pool.query(
      `SELECT COUNT(*) as count FROM production_orders`,
    );
    assert.equal(
      Number(ordersCount.rows[0].count),
      0,
      "No orphaned production_orders",
    );

    const pedidosCount = await pool.query(
      `SELECT COUNT(*) as count FROM production_order_pedidos`,
    );
    assert.equal(
      Number(pedidosCount.rows[0].count),
      0,
      "No orphaned production_order_pedidos",
    );
  });

  // ==========================================================================
  // SECCIÓN 10: AUTH REAL CON EXPRESS
  // ==========================================================================

  it("10A. Auth Real: Token correcto da acceso", async () => {
    const res = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({
          eventId: "11111111-1111-4111-8111-111111111111",
          pedidoId: "PED-1",
          numeroPedidoCliente: "26001",
          metros: 1000,
          bobinaMadre: 1000,
          camisa: "400",
          tipoMaterial: "OPP",
          micras: 30,
        }),
      },
    );
    assert.equal(res.status, 201);
  });

  it("10B. Auth Real: Token incorrecto retorna 401 Unauthorized", async () => {
    const res = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-invalid-secret-token",
        },
        body: JSON.stringify({}),
      },
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.code, "UNAUTHORIZED");
  });

  it("10C. Auth Real: Sin cabecera Authorization retorna 401 Unauthorized", async () => {
    const res = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.code, "UNAUTHORIZED");
  });

  it("10D. Auth Real: Variable de entorno no configurada retorna 503 Service Unavailable", async () => {
    const originalToken = process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN;
    delete process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN;

    try {
      const res = await fetch(
        `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_TOKEN}`,
          },
          body: JSON.stringify({}),
        },
      );
      assert.equal(res.status, 503);
      const body = (await res.json()) as any;
      assert.equal(body.code, "INTEGRATION_NOT_CONFIGURED");
    } finally {
      process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN = originalToken;
    }
  });

  it("10E. Auth Real: Endpoint de integración rechaza cookie de sesión de usuario como sustituto de Bearer", async () => {
    const userRes = await pool.query(`
      INSERT INTO users (nombre, email, password_hash, role, is_active)
      VALUES ('Web User', 'user@example.com', 'hash', 'USER', true)
      RETURNING id
    `);
    const sessionToken = "web-session-test-token";
    const crypto = await import("node:crypto");
    const sessionTokenHash = crypto
      .createHash("sha256")
      .update(sessionToken)
      .digest("hex");

    await pool.query(
      `
      INSERT INTO auth_sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, now() + interval '1 day')
    `,
      [sessionTokenHash, userRes.rows[0].id],
    );

    const res = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sid=${sessionToken}`,
        },
        body: JSON.stringify({}),
      },
    );
    assert.equal(
      res.status,
      401,
      "Rejects session cookie without Bearer token",
    );
  });
});
