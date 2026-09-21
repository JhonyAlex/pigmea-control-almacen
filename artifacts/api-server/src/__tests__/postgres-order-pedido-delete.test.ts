import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:test@localhost:5439/control_bobinas_order_pedido_delete_test";
process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN =
  "test-secret-nexus-token-xyz-123456";

const { Client } = pg;
const TEST_DB_URL = process.env.DATABASE_URL;
const NEXUS_TOKEN = process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN;

describe("Eliminación de pedidos agrupados dentro de una orden, contra PostgreSQL real", () => {
  let adminClient: pg.Client;
  let pool: pg.Pool;
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    adminClient = new Client({
      connectionString: "postgresql://postgres:test@localhost:5439/postgres",
    });
    await adminClient.connect();
    await adminClient.query(
      "DROP DATABASE IF EXISTS control_bobinas_order_pedido_delete_test",
    );
    await adminClient.query(
      "CREATE DATABASE control_bobinas_order_pedido_delete_test",
    );

    process.env.DATABASE_URL = TEST_DB_URL;

    const dbModule = await import("@workspace/db");
    pool = dbModule.pool;
    const db = dbModule.db;

    const { fileURLToPath } = await import("node:url");
    const migrationsFolder = fileURLToPath(
      new URL("../../../../lib/db/drizzle", import.meta.url),
    );
    await migrate(db, { migrationsFolder });

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
        "DROP DATABASE IF EXISTS control_bobinas_order_pedido_delete_test",
      );
      await adminClient.end();
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE production_order_events, production_order_pedidos, coils, production_orders, auth_sessions, users RESTART IDENTITY CASCADE",
    );
  });

  const registerAdmin = async () => {
    const res = await fetch(`${baseUrl}/api/auth/register-first`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: "Admin Pigmea",
        email: "admin@pigmea.test",
        password: "SuperSecretPassword123!",
      }),
    });
    const setCookie = res.headers.get("set-cookie") || "";
    return setCookie.split(";")[0];
  };

  const createUserSession = async (adminCookie: string) => {
    const createRes = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        nombre: "Operario",
        email: "operario@pigmea.test",
        password: "OtraContraseñaSegura123!",
        role: "USER",
      }),
    });
    assert.equal(createRes.status, 201);
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "operario@pigmea.test",
        password: "OtraContraseñaSegura123!",
      }),
    });
    const setCookie = loginRes.headers.get("set-cookie") || "";
    return setCookie.split(";")[0];
  };

  const sendNexus = async (payload: Record<string, unknown>) => {
    const response = await fetch(
      `${baseUrl}/api/integrations/gestion-pedidos/nexus-orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${NEXUS_TOKEN}`,
        },
        body: JSON.stringify(payload),
      },
    );
    return { response, body: (await response.json()) as any };
  };

  // Builds an ACTIVA GESTION_PEDIDOS order grouping 2 pedidos (5000m + 7000m),
  // matching what the "grouped pedidos" UI chip list requires to be shown.
  const createGroupedOrder = async () => {
    const first = await sendNexus({
      eventId: "a0000000-0000-4000-8000-000000000001",
      pedidoId: "PED-2026-001",
      numeroPedidoCliente: "2600101",
      metros: 5000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });
    const second = await sendNexus({
      eventId: "b0000000-0000-4000-8000-000000000002",
      pedidoId: "PED-2026-002",
      numeroPedidoCliente: "2600102",
      metros: 7000,
      bobinaMadre: 1200,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 30,
    });
    const orderId = first.body.orderId as number;
    const relRes = await pool.query(
      `SELECT id, pedido_id FROM production_order_pedidos WHERE orden_id = $1 ORDER BY vinculado_en ASC`,
      [orderId],
    );
    return {
      orderId,
      pedidoRelIds: relRes.rows.map((r) => r.id as number),
    };
  };

  it("Un admin elimina un pedido agrupado y la orden recalcula sus metros necesarios", async () => {
    const adminCookie = await registerAdmin();
    const { orderId, pedidoRelIds } = await createGroupedOrder();

    const res = await fetch(
      `${baseUrl}/api/orders/${orderId}/pedidos/${pedidoRelIds[0]}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.metrosNecesarios, 7000);
    assert.equal(body.pedidosRelacionados.length, 1);
    assert.equal(body.pedidosRelacionados[0].pedidoId, "PED-2026-002");

    const relRes = await pool.query(
      `SELECT * FROM production_order_pedidos WHERE orden_id = $1`,
      [orderId],
    );
    assert.equal(relRes.rows.length, 1);

    const orderRes = await pool.query(
      `SELECT metros_necesarios FROM production_orders WHERE id = $1`,
      [orderId],
    );
    assert.equal(Number(orderRes.rows[0].metros_necesarios), 7000);

    const eventRes = await pool.query(
      `SELECT accion FROM production_order_events WHERE orden_id = $1 ORDER BY id DESC LIMIT 1`,
      [orderId],
    );
    assert.equal(eventRes.rows[0].accion, "PEDIDO_ELIMINADO");
  });

  it("No se puede eliminar el único pedido vinculado a la orden", async () => {
    const adminCookie = await registerAdmin();
    const single = await sendNexus({
      eventId: "c0000000-0000-4000-8000-000000000003",
      pedidoId: "PED-UNICO",
      numeroPedidoCliente: "2600103",
      metros: 3000,
      bobinaMadre: 1500,
      camisa: "400",
      tipoMaterial: "OPP",
      micras: 25,
    });
    const orderId = single.body.orderId as number;
    const relRes = await pool.query(
      `SELECT id FROM production_order_pedidos WHERE orden_id = $1`,
      [orderId],
    );

    const res = await fetch(
      `${baseUrl}/api/orders/${orderId}/pedidos/${relRes.rows[0].id}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    assert.equal(res.status, 400);

    const stillThere = await pool.query(
      `SELECT COUNT(*) as count FROM production_order_pedidos WHERE orden_id = $1`,
      [orderId],
    );
    assert.equal(Number(stillThere.rows[0].count), 1);
  });

  it("Un usuario sin rol admin no puede eliminar un pedido de la orden", async () => {
    const adminCookie = await registerAdmin();
    const userCookie = await createUserSession(adminCookie);
    const { orderId, pedidoRelIds } = await createGroupedOrder();

    const res = await fetch(
      `${baseUrl}/api/orders/${orderId}/pedidos/${pedidoRelIds[0]}`,
      { method: "DELETE", headers: { Cookie: userCookie } },
    );
    assert.equal(res.status, 403);

    const relRes = await pool.query(
      `SELECT COUNT(*) as count FROM production_order_pedidos WHERE orden_id = $1`,
      [orderId],
    );
    assert.equal(Number(relRes.rows[0].count), 2);
  });

  it("No se puede eliminar un pedido de una orden bloqueada", async () => {
    const adminCookie = await registerAdmin();
    const { orderId, pedidoRelIds } = await createGroupedOrder();
    await pool.query(
      `UPDATE production_orders SET estado = 'BLOQUEADA' WHERE id = $1`,
      [orderId],
    );

    const res = await fetch(
      `${baseUrl}/api/orders/${orderId}/pedidos/${pedidoRelIds[0]}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    assert.equal(res.status, 400);

    const relRes = await pool.query(
      `SELECT COUNT(*) as count FROM production_order_pedidos WHERE orden_id = $1`,
      [orderId],
    );
    assert.equal(Number(relRes.rows[0].count), 2);
  });

  it("404 si la orden o el pedido no existen", async () => {
    const adminCookie = await registerAdmin();
    const { orderId, pedidoRelIds } = await createGroupedOrder();

    const missingOrder = await fetch(
      `${baseUrl}/api/orders/999999/pedidos/${pedidoRelIds[0]}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    assert.equal(missingOrder.status, 404);

    const missingPedido = await fetch(
      `${baseUrl}/api/orders/${orderId}/pedidos/999999`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    assert.equal(missingPedido.status, 404);
  });
});
