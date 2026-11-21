const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

// Load local .env if present (native in Node.js 20+)
try { process.loadEnvFile(); } catch (_) {}

// ---------- CONFIG: set via .env / environment variables ----------
const DB_PASSWORD = process.env.DB_PASSWORD || "YOUR_MYSQL_PASSWORD";
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || "root";
const DB_NAME = process.env.DB_NAME || "skylink";
const PORT = Number(process.env.PORT) || 3000;
// ----------------------------------------------------------------

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // return DATE/DATETIME as plain strings
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e.message);
    let msg = e.sqlMessage || e.message;
    if (e.code === "ER_DUP_ENTRY") msg = "Duplicate entry: " + msg;
    res.status(e.status || (e.code ? 400 : 500)).json({ error: msg });
  });
const need = (obj, fields) => {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === "")
      throw bad(`Missing field: ${f}`);
  }
};
const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be an integer`);
  return n;
};
const toAmount = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} must be a non-negative number`);
  return n;
};
const exists = async (conn, table, col, id) => {
  // table/col are fixed internal constants, never user input
  const [r] = await conn.query(`SELECT 1 FROM ${table} WHERE ${col}=?`, [id]);
  return r.length > 0;
};

// ---------- health & dashboard ----------
app.get("/api/health", h(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: DB_NAME });
}));

app.get("/api/stats", h(async (req, res) => {
  const count = async (t) => (await pool.query(`SELECT COUNT(*) n FROM ${t}`))[0][0].n;
  const [passengers, flights, bookings, baggage] = await Promise.all([
    count("Passenger"), count("Flight"), count("Booking"), count("Baggage"),
  ]);
  const [[confirmed]] = await pool.query(
    "SELECT COUNT(*) n FROM Booking WHERE booking_status='CONFIRMED'");
  res.json({ passengers, flights, bookings, baggage, confirmed: confirmed.n });
}));

// ---------- flights ----------
app.get("/api/flights", h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT f.flight_id,f.flight_number,al.airline_name,a1.airport_code src,a2.airport_code dest,
            f.departure_time,f.arrival_time,f.status
     FROM Flight f JOIN Airline al ON f.airline_id=al.airline_id
     JOIN Airport a1 ON f.source_airport=a1.airport_id
     JOIN Airport a2 ON f.destination_airport=a2.airport_id
     ORDER BY f.departure_time LIMIT 200`);
  res.json(rows);
}));

app.get("/api/flights/search", h(async (req, res) => {
  const { src, dest } = req.query;
  need(req.query, ["src", "dest"]);
  const [rows] = await pool.query(
    `SELECT f.flight_id,f.flight_number,al.airline_name,a1.airport_code src,a2.airport_code dest,
            f.departure_time,f.arrival_time,f.status
     FROM Flight f JOIN Airline al ON f.airline_id=al.airline_id
     JOIN Airport a1 ON f.source_airport=a1.airport_id
     JOIN Airport a2 ON f.destination_airport=a2.airport_id
     WHERE UPPER(a1.airport_code)=UPPER(?) AND UPPER(a2.airport_code)=UPPER(?)
     ORDER BY f.departure_time`, [src, dest]);
  res.json(rows);
}));

app.get("/api/flights/:id", h(async (req, res) => {
  const id = toInt(req.params.id, "Flight ID");
  const [rows] = await pool.query(
    `SELECT f.*,al.airline_name,a1.airport_code src,a1.airport_name src_name,
            a2.airport_code dest,a2.airport_name dest_name,ac.registration,ac.model,
            ac.manufacturer,ac.total_seats
     FROM Flight f JOIN Airline al ON f.airline_id=al.airline_id
     JOIN Airport a1 ON f.source_airport=a1.airport_id
     JOIN Airport a2 ON f.destination_airport=a2.airport_id
     LEFT JOIN Aircraft ac ON f.aircraft_id=ac.aircraft_id WHERE f.flight_id=?`, [id]);
  if (!rows.length) throw bad("Flight not found.", 404);
  res.json(rows[0]);
}));

app.patch("/api/flights/:id/status", h(async (req, res) => {
  const id = toInt(req.params.id, "Flight ID");
  need(req.body, ["status"]);
  const [r] = await pool.query("UPDATE Flight SET status=? WHERE flight_id=?",
    [String(req.body.status).trim(), id]);
  if (r.affectedRows === 0) throw bad("No flight updated. Check the Flight ID.", 404);
  res.json({ message: "Flight status updated." });
}));

app.get("/api/flights/:id/seats", h(async (req, res) => {
  const id = toInt(req.params.id, "Flight ID");
  const onlyFree = req.query.available === "1";
  const [rows] = await pool.query(
    `SELECT se.seat_id,se.seat_number,se.seat_class,se.seat_type,
            CASE WHEN b.booking_id IS NULL THEN 'AVAILABLE' ELSE 'BOOKED' END seat_status
     FROM Flight f JOIN Seat se ON se.aircraft_id=f.aircraft_id
     LEFT JOIN Booking b ON b.flight_id=f.flight_id AND b.seat_id=se.seat_id
     WHERE f.flight_id=? ${onlyFree ? "AND b.booking_id IS NULL" : ""}
     ORDER BY se.seat_number`, [id]);
  res.json(rows);
}));

// ---------- passengers ----------
app.post("/api/passengers", h(async (req, res) => {
  const b = req.body;
  need(b, ["first_name", "last_name", "email", "phone", "date_of_birth", "gender", "passport_no"]);
  const [r] = await pool.query(
    `INSERT INTO Passenger(first_name,last_name,email,phone,date_of_birth,gender,passport_no)
     VALUES(?,?,?,?,?,?,?)`,
    [b.first_name, b.last_name, b.email, b.phone, b.date_of_birth, b.gender, b.passport_no]);
  res.json({ message: "Passenger added.", passenger_id: r.insertId });
}));

app.get("/api/passengers/search", h(async (req, res) => {
  need(req.query, ["q"]);
  const [rows] = await pool.query(
    "SELECT * FROM Passenger WHERE passenger_id=? OR email=? OR passport_no=?",
    [req.query.q, req.query.q, req.query.q]);
  res.json(rows);
}));

app.get("/api/passengers/:id/bookings", h(async (req, res) => {
  const id = toInt(req.params.id, "Passenger ID");
  const [rows] = await pool.query(
    `SELECT b.booking_id,f.flight_number,a1.airport_code src,a2.airport_code dest,
            f.departure_time,se.seat_number,b.booking_class,b.booking_status,b.fare
     FROM Booking b JOIN Flight f ON b.flight_id=f.flight_id
     JOIN Airport a1 ON f.source_airport=a1.airport_id
     JOIN Airport a2 ON f.destination_airport=a2.airport_id
     LEFT JOIN Seat se ON b.seat_id=se.seat_id
     WHERE b.passenger_id=? ORDER BY f.departure_time`, [id]);
  res.json(rows);
}));

app.get("/api/passengers/:id/history", h(async (req, res) => {
  const id = toInt(req.params.id, "Passenger ID");
  const [rows] = await pool.query(
    `SELECT b.booking_id,f.flight_number,a1.airport_code src,a2.airport_code dest,
            f.departure_time,b.booking_date,b.booking_status,b.booking_class,b.fare
     FROM Booking b JOIN Flight f ON b.flight_id=f.flight_id
     JOIN Airport a1 ON f.source_airport=a1.airport_id
     JOIN Airport a2 ON f.destination_airport=a2.airport_id
     WHERE b.passenger_id=? ORDER BY b.booking_date DESC`, [id]);
  res.json(rows);
}));

// ---------- bookings ----------
app.post("/api/bookings", h(async (req, res) => {
  const b = req.body;
  need(b, ["passenger_id", "flight_id", "seat_id", "booking_class", "fare"]);
  const pid = toInt(b.passenger_id, "Passenger ID");
  const fid = toInt(b.flight_id, "Flight ID");
  const sid = toInt(b.seat_id, "Seat ID");
  const fare = toAmount(b.fare, "Fare");

  if (!(await exists(pool, "Passenger", "passenger_id", pid))) throw bad("Passenger not found.", 404);
  if (!(await exists(pool, "Flight", "flight_id", fid))) throw bad("Flight not found.", 404);
  const [ck] = await pool.query(
    `SELECT 1 FROM Seat se JOIN Flight f ON se.aircraft_id=f.aircraft_id
     WHERE se.seat_id=? AND f.flight_id=?`, [sid, fid]);
  if (!ck.length) throw bad("Seat does not belong to this flight's aircraft.");
  try {
    const [r] = await pool.query(
      `INSERT INTO Booking(passenger_id,flight_id,seat_id,booking_date,booking_class,booking_status,fare)
       VALUES(?,?,?,NOW(),?,'CONFIRMED',?)`,
      [pid, fid, sid, b.booking_class, fare]);
    res.json({ message: "Booking created successfully.", booking_id: r.insertId });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      throw bad("That seat is already assigned to a booking on this flight.", 409);
    throw e;
  }
}));

app.get("/api/bookings/:id", h(async (req, res) => {
  const id = toInt(req.params.id, "Booking ID");
  const [rows] = await pool.query(
    `SELECT b.*,p.first_name,p.last_name,p.email,p.phone,f.flight_number,
            f.departure_time,f.arrival_time,f.status flight_status,a1.airport_code src,
            a2.airport_code dest,se.seat_number
     FROM Booking b JOIN Passenger p ON b.passenger_id=p.passenger_id
     JOIN Flight f ON b.flight_id=f.flight_id
     JOIN Airport a1 ON f.source_airport=a1.airport_id
     JOIN Airport a2 ON f.destination_airport=a2.airport_id
     LEFT JOIN Seat se ON b.seat_id=se.seat_id WHERE b.booking_id=?`, [id]);
  if (!rows.length) throw bad("Booking not found.", 404);
  res.json(rows[0]);
}));

app.post("/api/bookings/:id/cancel", h(async (req, res) => {
  const id = toInt(req.params.id, "Booking ID");
  need(req.body, ["reason"]);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      "SELECT booking_status FROM Booking WHERE booking_id=? FOR UPDATE", [id]);
    if (!r.length) throw bad("Booking not found.", 404);
    if (r[0].booking_status === "CANCELLED") throw bad("Booking is already cancelled.", 409);
    await conn.query("UPDATE Booking SET booking_status='CANCELLED' WHERE booking_id=?", [id]);
    await conn.query(
      `INSERT INTO Cancellation(booking_id,cancellation_date,reason,refund_amount,refund_status)
       VALUES(?,NOW(),?,0,'PENDING')`, [id, req.body.reason]);
    await conn.commit();
    res.json({ message: "Booking cancelled. Cancellation record created; refund status is PENDING." });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

// ---------- payments & refunds ----------
app.post("/api/payments", h(async (req, res) => {
  need(req.body, ["booking_id", "method"]);
  const id = toInt(req.body.booking_id, "Booking ID");
  const [b] = await pool.query("SELECT fare,booking_status FROM Booking WHERE booking_id=?", [id]);
  if (!b.length) throw bad("Booking not found.", 404);
  if (b[0].booking_status !== "CONFIRMED") throw bad("Only confirmed bookings can be paid.");
  const [old] = await pool.query(
    "SELECT payment_id FROM Payment WHERE booking_id=? AND payment_status='SUCCESS'", [id]);
  if (old.length) throw bad("A successful payment already exists.", 409);
  const fare = Number(b[0].fare);
  const txn = "SKY" + Math.floor(Date.now() / 1000) + id;
  await pool.query(
    `INSERT INTO Payment(booking_id,amount,payment_date,payment_method,payment_status,transaction_id)
     VALUES(?,?,NOW(),?,'SUCCESS',?)`, [id, fare, req.body.method, txn]);
  res.json({ message: "Payment record created.", amount: fare, transaction_id: txn, status: "SUCCESS" });
}));

app.post("/api/refunds", h(async (req, res) => {
  need(req.body, ["booking_id", "refund_amount"]);
  const id = toInt(req.body.booking_id, "Booking ID");
  const refund = toAmount(req.body.refund_amount, "Refund amount");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `SELECT c.cancellation_id,c.refund_status,b.fare FROM Cancellation c
       JOIN Booking b ON c.booking_id=b.booking_id WHERE c.booking_id=?
       ORDER BY c.cancellation_id DESC LIMIT 1 FOR UPDATE`, [id]);
    if (!r.length) throw bad("No cancellation record found.", 404);
    if (r[0].refund_status === "REFUNDED") throw bad("This booking is already refunded.", 409);
    if (refund > Number(r[0].fare)) throw bad(`Refund cannot exceed fare Rs. ${r[0].fare}.`);
    await conn.query(
      "UPDATE Cancellation SET refund_amount=?,refund_status='REFUNDED' WHERE cancellation_id=?",
      [refund, r[0].cancellation_id]);
    const txn = "RF" + Math.floor(Date.now() / 1000) + id;
    await conn.query(
      `INSERT INTO Payment(booking_id,amount,payment_date,payment_method,payment_status,transaction_id)
       VALUES(?,?,NOW(),'REFUND','REFUNDED',?)`, [id, refund, txn]);
    await conn.commit();
    res.json({ message: "Refund record created.", amount: refund, status: "REFUNDED", reference: txn });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

// ---------- baggage ----------
app.post("/api/baggage", h(async (req, res) => {
  const b = req.body;
  need(b, ["booking_id", "bag_tag_no", "weight", "baggage_type"]);
  const id = toInt(b.booking_id, "Booking ID");
  const weight = toAmount(b.weight, "Weight");
  if (!(await exists(pool, "Booking", "booking_id", id))) throw bad("Booking not found.", 404);
  const [r] = await pool.query(
    `INSERT INTO Baggage(booking_id,bag_tag_no,weight,baggage_type,baggage_status)
     VALUES(?,?,?,?,'RECEIVED')`, [id, b.bag_tag_no, weight, b.baggage_type]);
  res.json({ message: "Baggage added.", baggage_id: r.insertId });
}));

app.get("/api/baggage/:tag", h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT bg.*,b.booking_id,p.first_name,p.last_name,f.flight_number
     FROM Baggage bg JOIN Booking b ON bg.booking_id=b.booking_id
     JOIN Passenger p ON b.passenger_id=p.passenger_id
     JOIN Flight f ON b.flight_id=f.flight_id WHERE bg.bag_tag_no=?`, [req.params.tag]);
  if (!rows.length) throw bad("Baggage tag not found.", 404);
  res.json(rows[0]);
}));

// ---------- check-in & boarding pass ----------
app.post("/api/checkin", h(async (req, res) => {
  need(req.body, ["booking_id", "method"]);
  const id = toInt(req.body.booking_id, "Booking ID");
  const [b] = await pool.query("SELECT booking_status FROM Booking WHERE booking_id=?", [id]);
  if (!b.length) throw bad("Booking not found.", 404);
  if (b[0].booking_status !== "CONFIRMED") throw bad("Only confirmed bookings can check in.");
  const [old] = await pool.query("SELECT checkin_id FROM Check_In WHERE booking_id=?", [id]);
  if (old.length) throw bad("Check-in already exists for this booking.", 409);
  const [r] = await pool.query(
    `INSERT INTO Check_In(booking_id,checkin_time,checkin_method,checkin_status)
     VALUES(?,NOW(),?,'CHECKED_IN')`, [id, req.body.method]);
  res.json({ message: "Check-in successful.", checkin_id: r.insertId });
}));

app.post("/api/boarding-pass", h(async (req, res) => {
  need(req.body, ["booking_id", "gate", "boarding_group"]);
  const id = toInt(req.body.booking_id, "Booking ID");
  const [q] = await pool.query(
    `SELECT b.passenger_id,b.booking_status,p.first_name,p.last_name,f.flight_number,
            f.departure_time,a1.airport_code src,a2.airport_code dest,se.seat_number
     FROM Booking b JOIN Passenger p ON b.passenger_id=p.passenger_id
     JOIN Flight f ON b.flight_id=f.flight_id
     JOIN Airport a1 ON f.source_airport=a1.airport_id
     JOIN Airport a2 ON f.destination_airport=a2.airport_id
     LEFT JOIN Seat se ON b.seat_id=se.seat_id WHERE b.booking_id=?`, [id]);
  if (!q.length) throw bad("Booking not found.", 404);
  const r = q[0];
  if (r.booking_status !== "CONFIRMED") throw bad("Booking is not confirmed.");
  const [ck] = await pool.query(
    "SELECT checkin_id FROM Check_In WHERE booking_id=? AND checkin_status='CHECKED_IN'", [id]);
  if (!ck.length) throw bad("Complete check-in before generating the boarding pass.");

  const pass = {
    passenger: `${r.first_name} ${r.last_name}`,
    flight: r.flight_number,
    route: `${r.src} -> ${r.dest}`,
    src: r.src, dest: r.dest,
    departure: r.departure_time,
    seat: r.seat_number,
  };
  const [old] = await pool.query(
    "SELECT boarding_pass_id,gate,boarding_group,barcode FROM Boarding_Pass WHERE booking_id=?", [id]);
  if (old.length) {
    return res.json({ existing: true, message: "Boarding pass already exists.",
      pass_id: old[0].boarding_pass_id, gate: old[0].gate,
      boarding_group: old[0].boarding_group, barcode: old[0].barcode, ...pass });
  }
  const barcode = `SKY-${Math.floor(Date.now() / 1000)}-${id}`;
  const [ins] = await pool.query(
    `INSERT INTO Boarding_Pass(booking_id,passenger_id,gate,boarding_group,issued_at,barcode)
     VALUES(?,?,?,?,NOW(),?)`,
    [id, r.passenger_id, req.body.gate, req.body.boarding_group, barcode]);
  res.json({ existing: false, message: "Boarding pass generated.", pass_id: ins.insertId,
    gate: req.body.gate, boarding_group: req.body.boarding_group, barcode, ...pass });
}));

// ---------- start ----------
app.listen(PORT, async () => {
  console.log(`\nSkyLink running at http://localhost:${PORT}`);
  try {
    await pool.query("SELECT 1");
    console.log(`Database status: CONNECTED (${DB_NAME})`);
  } catch (e) {
    console.error("Database status: FAILED ->", e.message);
    console.error("Check MySQL Server is running, database 'skylink' exists, and DB_PASSWORD in server.js is correct.");
  }
});
