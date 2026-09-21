import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:test@localhost:5439/control_bobinas_orderlock_test";
process.env.GESTION_PEDIDOS_INTEGRATION_TOKEN =
  "test-secret-nexus-token-xyz-123456";

const { Pool, Client } = pg;
const TEST_DB_URL = process.env.DATABASE_URL;

const LOCKED_MESSAGE =
  "No se pueden modificar las características de una orden que ya tiene material registrado o asignado.";

interface OrderBody {
  ancho: number;
  micras: number;
  camisa: number | string;
  material: string;
  metrosNecesarios: number;
}

describe("Bloqueo de características de órdenes con cobertura contra PostgreSQL real", () => {
  let adminClient: pg.Client;
  let pool: pg.Pool;
  let server: http.Server;
  let baseUrl: string;
  let sessionCookie: string;

  const seedCoil = async (
    overrides: Partial<{
      tipo: string;
      metros: string;
      ancho: string;
      micras: string;
      camisa: number | string;
      material: string;
      estado: string;
      orden_id: number | null;
    }> = {},
  ): Promise<number> => {
    const values = {
      tipo: "RESTO",
      metros: "5000.00",
      ancho: "1200.00",
      micras: "30.00",
      camisa: 400,
      material: "OPP",
      estado: "DISPONIBLE",
      orden_id: null as number | null,
      ...overrides,
    };
    const res = await pool.query(
      `INSERT INTO coils (tipo, metros, ancho, micras, camisa, material, estado, orden_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        values.tipo,
        values.metros,
        values.ancho,
        values.micras,
        values.camisa,
        values.material,
        values.estado,
        values.orden_id,
      ],
    );
    return res.rows[0].id as number;
  };

  const insertOrder = async (
    overrides: Partial<{
      ancho: string;
      micras: string;
      camisa: number | string;
      material: string;
      metros_necesarios: string;
      estado: string;
      origen: string;
    }> = {},
  ): Promise<number> => {
    const values = {
      ancho: "1200.00",
      micras: "30.00",
      camisa: "400",
      material: "OPP",
      metros_necesarios: "5000.00",
      estado: "ACTIVA",
      origen: "MANUAL",
      ...overrides,
    };
    const res = await pool.query(
      `INSERT INTO production_orders (ancho, micras, camisa, material, metros_necesarios, estado, origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        values.ancho,
        values.micras,
        values.camisa,
        values.material,
        values.metros_necesarios,
        values.estado,
        values.origen,
      ],
    );
    return res.rows[0].id as number;
  };

  /** Orden manual con una bobina fabricada (coils.orden_id) ya registrada. */
  const seedOrderWithFabricatedCoil = async (
    coilMetros = "2000.00",
    orderMetrosNecesarios = "5000.00",
  ): Promise<number> => {
    const orderId = await insertOrder({
      metros_necesarios: orderMetrosNecesarios,
    });
    await seedCoil({ tipo: "BOBINA", metros: coilMetros, orden_id: orderId });
    return orderId;
  };

  const createOrder = async (body: OrderBody) => {
    const res = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const patchOrder = async (id: number, body: OrderBody) => {
    const res = await fetch(`${baseUrl}/api/orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const assignmentsOf = async (orderId: number) => {
    const res = await pool.query(
      "SELECT * FROM production_order_coil_assignments WHERE orden_id = $1 ORDER BY coil_id",
      [orderId],
    );
    return res.rows;
  };

  const orderRow = async (id: number) => {
    const res = await pool.query(
      "SELECT ancho, micras, camisa, material, metros_necesarios, estado FROM production_orders WHERE id = $1",
      [id],
    );
    return res.rows[0];
  };

  const NO_COBERTURA_ORDER: OrderBody = {
    ancho: 1200,
    micras: 30,
    camisa: 400,
    material: "OPP",
    metrosNecesarios: 5000,
  };

  before(async () => {
    adminClient = new Client({
      connectionString: "postgresql://postgres:test@localhost:5439/postgres",
    });
    await adminClient.connect();
    await adminClient.query(
      "DROP DATABASE IF EXISTS control_bobinas_orderlock_test",
    );
    await adminClient.query("CREATE DATABASE control_bobinas_orderlock_test");

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
    const setCookie = regRes.headers.get("set-cookie") || "";
    sessionCookie = setCookie.split(";")[0];
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
        "DROP DATABASE IF EXISTS control_bobinas_orderlock_test",
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
  // SIN COBERTURA: LAS CARACTERÍSTICAS SIGUEN EDITABLES
  // =========================================================================

  it("L1. Orden sin cobertura → permite cambiar ancho, micras, camisa, material y metros", async () => {
    // Sin stock compatible sembrado: la orden creada queda con cobertura 0
    const { body: order } = await createOrder(NO_COBERTURA_ORDER);
    assert.equal(order.metrosFabricados, 0);

    const { status, body } = await patchOrder(order.id, {
      ancho: 1250,
      micras: 35,
      camisa: 475,
      material: "OPP RECICLADO",
      metrosNecesarios: 6000,
    });

    assert.equal(status, 200);
    assert.equal(body.ancho, 1250);
    assert.equal(body.micras, 35);
    assert.equal(body.camisa, "475", "camisa sale como texto almacenado");
    assert.equal(body.material, "OPP RECICLADO");
    assert.equal(body.metrosNecesarios, 6000);
    assert.equal(body.estado, "ACTIVA");

    const row = await orderRow(order.id);
    assert.equal(row.ancho, "1250.00");
    assert.equal(row.micras, "35.00");
    assert.equal(row.camisa, "475");
    assert.equal(row.material, "OPP RECICLADO");
    assert.equal(row.metros_necesarios, "6000.00");
  });

  // =========================================================================
  // CON COBERTURA POR BOBINA FABRICADA (coils.orden_id): CARACTERÍSTICAS BLOQUEADAS
  // =========================================================================

  it("L2. Orden con BOBINA fabricada → cambiar material devuelve 409 ORDER_CHARACTERISTICS_LOCKED", async () => {
    const orderId = await seedOrderWithFabricatedCoil();

    const { status, body } = await patchOrder(orderId, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP RECICLADO",
      metrosNecesarios: 5000,
    });

    assert.equal(status, 409);
    assert.equal(body.code, "ORDER_CHARACTERISTICS_LOCKED");
    assert.equal(body.error, LOCKED_MESSAGE);

    const row = await orderRow(orderId);
    assert.equal(row.material, "OPP", "el material de la orden no cambia");
  });

  it("L3. Orden con BOBINA fabricada → cambiar solo camisa, ancho o micras devuelve 409", async () => {
    const orderId = await seedOrderWithFabricatedCoil();

    const camisaRes = await patchOrder(orderId, {
      ancho: 1200,
      micras: 30,
      camisa: 475,
      material: "OPP",
      metrosNecesarios: 5000,
    });
    assert.equal(camisaRes.status, 409);
    assert.equal(camisaRes.body.code, "ORDER_CHARACTERISTICS_LOCKED");

    const anchoRes = await patchOrder(orderId, {
      ancho: 1250,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 5000,
    });
    assert.equal(anchoRes.status, 409);
    assert.equal(anchoRes.body.code, "ORDER_CHARACTERISTICS_LOCKED");

    const micrasRes = await patchOrder(orderId, {
      ancho: 1200,
      micras: 35,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 5000,
    });
    assert.equal(micrasRes.status, 409);
    assert.equal(micrasRes.body.code, "ORDER_CHARACTERISTICS_LOCKED");

    const row = await orderRow(orderId);
    assert.equal(row.ancho, "1200.00");
    assert.equal(row.micras, "30.00");
    assert.equal(row.camisa, "400");
  });

  it("L4. Orden con BOBINA fabricada → reenviar los mismos valores en formato equivalente no bloquea", async () => {
    // Guardados como '1200.00' / '30.00' / '400' (texto): se reenvían como
    // números; debe tratarse como sin cambios, no como un 409.
    const orderId = await seedOrderWithFabricatedCoil();

    const { status, body } = await patchOrder(orderId, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 5000,
    });

    assert.equal(status, 200, "no debe bloquear valores equivalentes");
    assert.equal(body.ancho, 1200);
    assert.equal(body.micras, 30);
    assert.equal(body.camisa, "400");
  });

  // =========================================================================
  // CON COBERTURA POR RESTO AUTOASIGNADO (production_order_coil_assignments)
  // =========================================================================

  it("L5. Orden con RESTO autoasignado → cambiar características devuelve 409 y conserva la asignación", async () => {
    await seedCoil({ metros: "1500.00" });
    const { body: order } = await createOrder(NO_COBERTURA_ORDER);
    assert.equal(order.metrosFabricados, 1500, "resto autoasignado al crear");

    const { status, body } = await patchOrder(order.id, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP RECICLADO",
      metrosNecesarios: 5000,
    });

    assert.equal(status, 409);
    assert.equal(body.code, "ORDER_CHARACTERISTICS_LOCKED");
    assert.equal(body.error, LOCKED_MESSAGE);

    const row = await orderRow(order.id);
    assert.equal(row.material, "OPP");
    const assignments = await assignmentsOf(order.id);
    assert.equal(assignments.length, 1, "la asignación se conserva");
  });

  it("L6. Orden con cobertura → aumentar metrosNecesarios sí funciona", async () => {
    const orderId = await seedOrderWithFabricatedCoil("2000.00", "5000.00");

    const { status, body } = await patchOrder(orderId, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 7000,
    });

    assert.equal(status, 200);
    assert.equal(body.metrosNecesarios, 7000);
    assert.equal(body.metrosFabricados, 2000);
    assert.equal(body.metrosPendientes, 5000);
    assert.equal(body.estado, "ACTIVA");
    const row = await orderRow(orderId);
    assert.equal(row.metros_necesarios, "7000.00");
  });

  it("L7. Orden con cobertura → reducir metrosNecesarios por debajo de la cobertura se rechaza", async () => {
    const orderId = await seedOrderWithFabricatedCoil("2000.00", "5000.00");

    const { status, body } = await patchOrder(orderId, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 1500,
    });

    assert.equal(status, 400);
    assert.equal(
      body.error,
      "Los metros necesarios no pueden ser inferiores a los ya cubiertos",
    );
    const row = await orderRow(orderId);
    assert.equal(row.metros_necesarios, "5000.00", "metros sin cambios");
  });

  it("L8. Editar metros sin cambiar características dispara nueva autoasignación de RESTOS compatibles", async () => {
    await seedCoil({ metros: "1500.00" });
    const { body: order } = await createOrder(NO_COBERTURA_ORDER);
    assert.equal(order.metrosFabricados, 1500);

    // Stock compatible que entra a almacén después de crear la orden
    const newRestoId = await seedCoil({ metros: "2000.00" });

    const { status, body } = await patchOrder(order.id, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 6000,
    });

    assert.equal(status, 200);
    assert.equal(body.metrosNecesarios, 6000);
    assert.equal(
      body.metrosFabricados,
      3500,
      "el nuevo resto compatible se autoasigna al ampliar la orden",
    );

    const assignments = await assignmentsOf(order.id);
    assert.equal(assignments.length, 2);
    const added = assignments.find((a) => a.coil_id === newRestoId);
    assert.ok(added, "el segundo resto queda asignado");
    assert.equal(Number(added.metros), 2000);
    assert.equal(added.origen, "AUTO_STOCK");
    const coilRes = await pool.query(
      "SELECT tipo FROM coils WHERE id = $1",
      [newRestoId],
    );
    assert.equal(coilRes.rows[0].tipo, "RESTO", "solo se autoasignan RESTOS");
  });

  it("L9. Cobertura combinada (BOBINA fabricada + RESTO asignado) → bloquea características y permite ampliar metros", async () => {
    await seedCoil({ metros: "1500.00" });
    const { body: order } = await createOrder(NO_COBERTURA_ORDER);
    assert.equal(order.metrosFabricados, 1500);
    await seedCoil({ tipo: "BOBINA", metros: "1000.00", orden_id: order.id });

    const locked = await patchOrder(order.id, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP RECICLADO",
      metrosNecesarios: 5000,
    });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.code, "ORDER_CHARACTERISTICS_LOCKED");

    const enlarged = await patchOrder(order.id, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 4000,
    });
    assert.equal(enlarged.status, 200);
    assert.equal(enlarged.body.metrosFabricados, 2500);
    assert.equal(enlarged.body.metrosNecesarios, 4000);
  });

  // =========================================================================
  // CONCURRENCIA: VALIDACIÓN Y ESCRITURA EN LA MISMA TRANSACCIÓN
  // =========================================================================

  it("L10. Registrar cobertura mientras el PATCH espera el lock → el PATCH ve la cobertura y devuelve 409", async () => {
    const { body: order } = await createOrder(NO_COBERTURA_ORDER);
    assert.equal(order.metrosFabricados, 0);

    // Una transacción externa retiene el lock de la fila de la orden: aquí es
    // donde el PATCH antiguo ya habría validado con cobertura 0.
    const locker = new Client({ connectionString: TEST_DB_URL });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query(
      "SELECT id FROM production_orders WHERE id = $1 FOR UPDATE",
      [order.id],
    );

    let patchSettled = false;
    const patchPromise = patchOrder(order.id, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP RECICLADO",
      metrosNecesarios: 5000,
    }).then((result) => {
      patchSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      patchSettled,
      false,
      "el PATCH debe esperar al FOR UPDATE de la fila de la orden",
    );

    // Mientras el PATCH espera, se registra material físico para la orden
    await locker.query(
      `INSERT INTO coils (tipo, metros, ancho, micras, camisa, material, estado, orden_id)
       VALUES ('BOBINA','2000.00','1200.00','30.00','400','OPP','DISPONIBLE',$1)`,
      [order.id],
    );
    await locker.query("COMMIT");
    await locker.end();

    // Al obtener el lock, el PATCH recalcula cobertura dentro de su
    // transacción y rechaza el cambio de material.
    const { status, body } = await patchPromise;
    assert.equal(status, 409);
    assert.equal(body.code, "ORDER_CHARACTERISTICS_LOCKED");

    const row = await orderRow(order.id);
    assert.equal(
      row.material,
      "OPP",
      "la orden no queda con características inconsistentes respecto al material vinculado",
    );
    const coilRes = await pool.query(
      "SELECT orden_id, material FROM coils WHERE orden_id = $1",
      [order.id],
    );
    assert.equal(coilRes.rows.length, 1, "la bobina fabricada sigue vinculada");
    assert.equal(coilRes.rows[0].material, "OPP");
  });

  // =========================================================================
  // REGRESIÓN: VALIDACIONES MOVIDAS DENTRO DE LA TRANSACCIÓN
  // =========================================================================

  it("L11. Orden GESTION_PEDIDOS sin material registrado: el administrador puede editarla", async () => {
    const orderId = await insertOrder({ origen: "GESTION_PEDIDOS" });

    const { status } = await patchOrder(orderId, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP RECICLADO",
      metrosNecesarios: 5000,
    });

    assert.equal(status, 200);
    const row = await orderRow(orderId);
    assert.equal(row.material, "OPP RECICLADO");
  });

  it("L11b. Orden GESTION_PEDIDOS: editar hacia un grupo ya activo devuelve 409 DUPLICATE_ACTIVE_GROUP", async () => {
    await insertOrder({
      origen: "GESTION_PEDIDOS",
      ancho: "1250.00",
      micras: "35.00",
      camisa: "475",
    });
    const orderId = await insertOrder({ origen: "GESTION_PEDIDOS" });

    const { status, body } = await patchOrder(orderId, {
      ancho: 1250,
      micras: 35,
      camisa: 475,
      material: "OPP",
      metrosNecesarios: 5000,
    });

    assert.equal(status, 409);
    assert.equal(body.code, "DUPLICATE_ACTIVE_GROUP");
    const row = await orderRow(orderId);
    assert.equal(Number(row.ancho), 1200);
    assert.equal(row.camisa, "400");
  });

  it("L12. Regresión: orden BLOQUEADA devuelve 400 y orden inexistente devuelve 404", async () => {
    const blockedId = await insertOrder({ estado: "BLOQUEADA" });
    const blockedRes = await patchOrder(blockedId, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 5000,
    });
    assert.equal(blockedRes.status, 400);
    assert.equal(blockedRes.body.error, "Solo se pueden editar órdenes activas");

    const missingRes = await patchOrder(9999, {
      ancho: 1200,
      micras: 30,
      camisa: 400,
      material: "OPP",
      metrosNecesarios: 5000,
    });
    assert.equal(missingRes.status, 404);
    assert.equal(missingRes.body.error, "La orden no existe");
  });
});
