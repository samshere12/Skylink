/* SkyLink frontend. Talks to the Express API in server.js. */
const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "Rs. " + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (s) => (s ? String(s).replace("T", " ").slice(0, 16) : "");
const hhmm = (s) => (s ? String(s).replace("T", " ").slice(11, 16) : "");

async function api(path, method = "GET", body) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the SkyLink server. Start it with 'npm start' and reload.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
  return data;
}

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 3200);
}

const pillClass = (s) => {
  s = String(s || "").toUpperCase();
  if (["CONFIRMED", "SCHEDULED", "ON_TIME", "SUCCESS", "CHECKED_IN", "BOARDING", "COMPLETED", "REFUNDED", "DELIVERED", "RECEIVED"].includes(s)) return "good";
  if (["CANCELLED", "DELAYED", "FAILED", "PENDING"].includes(s)) return "bad";
  return "neutral";
};
const pill = (s) => `<span class="pill ${pillClass(s)}">${esc(s)}</span>`;

function table(rows, cols, opts = {}) {
  if (!rows.length) return `<p class="empty">${esc(opts.empty || "Nothing found.")}</p>`;
  const head = cols.map((c) => `<th>${esc(c[0])}</th>`).join("");
  const body = rows
    .map((r, i) => `<tr ${opts.click ? `class="click" tabindex="0" data-i="${i}"` : ""}>${cols.map((c) => `<td>${c[2] ? c[2](r) : esc(r[c[1]])}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function onRows(root, rows, fn) {
  root.querySelectorAll("tr.click").forEach((tr) => {
    const go = () => fn(rows[tr.dataset.i]);
    tr.onclick = go;
    tr.onkeydown = (e) => e.key === "Enter" && go();
  });
}
const kv = (pairs) => `<dl class="kv">${pairs.filter((p) => p[1] !== undefined).map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join("")}</dl>`;

/* Wire a <form> to an API call. render(result, form) returns HTML for the result area. */
function wire(form, out, call, render) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const data = Object.fromEntries(new FormData(form));
    btn && (btn.disabled = true);
    try {
      const r = await call(data);
      out.innerHTML = render(r, data);
      out.dispatchEvent(new CustomEvent("rendered", { detail: r }));
    } catch (err) {
      out.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    } finally {
      btn && (btn.disabled = false);
    }
  });
}
const ok = (m) => `<div class="msg ok">${esc(m)}</div>`;

/* ---------- seat map ---------- */
function seatMap(seats, { pick } = {}) {
  const rows = {};
  seats.forEach((s) => {
    const m = String(s.seat_number).match(/^(\d+)\s*([A-Za-z]+)$/);
    const r = m ? m[1] : "";
    const l = m ? m[2] : s.seat_number;
    (rows[r] = rows[r] || []).push({ ...s, letter: l });
  });
  const keys = Object.keys(rows).sort((a, b) => a - b);
  const all = [...new Set(seats.map((s) => String(s.seat_number).replace(/^\d+/, "")))].sort();
  const mid = Math.ceil(all.length / 2);
  const cabin = keys
    .map((k) => {
      const byL = Object.fromEntries(rows[k].map((s) => [s.letter, s]));
      const cells = all
        .map((l, i) => {
          const s = byL[l];
          const gap = i === mid && all.length > 3 ? '<span class="aisle"></span>' : "";
          if (!s) return gap + '<span class="seat" style="visibility:hidden"></span>';
          const booked = s.seat_status === "BOOKED";
          return `${gap}<button type="button" class="seat ${booked ? "booked" : ""}" data-id="${s.seat_id}" data-num="${esc(s.seat_number)}" ${booked ? "disabled" : ""} aria-label="Seat ${esc(s.seat_number)}, ${esc(s.seat_class)}, ${booked ? "booked" : "available"}" title="${esc(s.seat_number)} ${esc(s.seat_class)}">${esc(l)}</button>`;
        })
        .join("");
      return `<div class="srow"><span class="rn">${esc(k)}</span>${cells}</div>`;
    })
    .join("");
  const box = document.createElement("div");
  box.innerHTML = `<div class="cabin">${cabin}</div><div class="legend"><span><i></i>Available</span><span><i class="b"></i>Booked</span>${pick ? '<span><i class="s"></i>Your pick</span>' : ""}</div>`;
  if (pick)
    box.querySelectorAll(".seat:not(.booked)").forEach((b) => {
      b.onclick = () => {
        box.querySelectorAll(".seat.sel").forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        pick({ id: b.dataset.id, num: b.dataset.num });
      };
    });
  return box;
}

/* ---------- pages ---------- */
const pages = {};

pages.dashboard = async () => {
  view.innerHTML = `<h1>Departures</h1><p class="lede">Every flight in the SkyLink database, soonest first. Select a flight to manage it.</p><div class="counts" id="counts"></div><div class="panel dark" id="board"><p class="empty">Loading flights…</p></div>`;
  api("/stats").then((s) => {
    $("#counts").innerHTML = [["passengers", s.passengers], ["flights", s.flights], ["bookings", s.bookings], ["confirmed", s.confirmed], ["bags", s.baggage]].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join("");
  }).catch(() => {});
  try {
    const rows = await api("/flights");
    $("#board").innerHTML = table(rows, [
      ["Departs", "", (r) => `<span class="time">${esc(hhmm(r.departure_time))}</span> <small>${esc(String(r.departure_time).slice(0, 10))}</small>`],
      ["Flight", "flight_number", (r) => `<span class="big">${esc(r.flight_number)}</span>`],
      ["Route", "", (r) => `<span class="route">${esc(r.src)} → ${esc(r.dest)}</span>`],
      ["Airline", "airline_name"],
      ["Arrives", "", (r) => esc(when(r.arrival_time))],
      ["Status", "", (r) => pill(r.status)],
    ], { click: true, empty: "No flights yet. Add flights to the database and reload." });
    onRows($("#board"), rows, (r) => (location.hash = "#/flights/" + r.flight_id));
  } catch (e) {
    $("#board").innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
  }
};

pages.passengers = () => {
  view.innerHTML = `<h1>Passengers</h1><p class="lede">Register a passenger, look one up, or review their trips.</p>
  <div class="grid cols-2">
    <section class="panel"><h2>Add passenger</h2>
      <form id="add">
        <div class="row"><label>First name<input name="first_name" required></label><label>Last name<input name="last_name" required></label></div>
        <div class="row"><label>Email<input name="email" type="email" required></label><label>Phone<input name="phone" required></label></div>
        <div class="row"><label>Date of birth<input name="date_of_birth" type="date" required></label>
          <label>Gender<select name="gender"><option>Male</option><option>Female</option><option>Other</option></select></label></div>
        <label>Passport number<input name="passport_no" required></label>
        <div class="actions"><button type="submit">Add passenger</button></div>
      </form><div class="result" id="addR"></div></section>
    <section class="panel"><h2>Find a passenger</h2>
      <form id="find"><label>Passenger ID, email or passport number<input name="q" required></label>
        <div class="actions"><button type="submit">Search</button></div></form>
      <div class="result" id="findR"></div></section>
  </div>
  <section class="panel"><h2>Trips by passenger</h2>
    <form id="trips" class="row" style="align-items:end"><label>Passenger ID<input name="id" type="number" min="1" required></label>
      <div class="actions"><button type="submit" data-m="bookings">Current bookings</button><button type="submit" class="ghost" data-m="history">Booking history</button></div></form>
    <div class="result" id="tripsR"></div></section>`;
  wire($("#add"), $("#addR"), (d) => api("/passengers", "POST", d), (r) => ok(`Passenger added. Passenger ID: ${r.passenger_id}`));
  wire($("#find"), $("#findR"), (d) => api("/passengers/search?q=" + encodeURIComponent(d.q)), (rows) =>
    rows.length ? rows.map((p) => `<div class="card-sep">${kv([["Passenger ID", p.passenger_id], ["Name", p.first_name + " " + p.last_name], ["Email", p.email], ["Phone", p.phone], ["Date of birth", String(p.date_of_birth).slice(0, 10)], ["Gender", p.gender], ["Passport", p.passport_no]])}</div>`).join("") : '<p class="empty">No passenger matches that ID, email or passport number.</p>');
  let mode = "bookings";
  $("#trips").querySelectorAll("button").forEach((b) => (b.onclick = () => (mode = b.dataset.m)));
  wire($("#trips"), $("#tripsR"), (d) => api(`/passengers/${d.id}/${mode}`), (rows) =>
    table(rows, [
      ["Booking", "", (r) => "#" + r.booking_id], ["Flight", "flight_number"],
      ["Route", "", (r) => `${esc(r.src)} → ${esc(r.dest)}`], ["Departs", "", (r) => esc(when(r.departure_time))],
      ...(mode === "history" ? [["Booked on", "", (r) => esc(when(r.booking_date))]] : [["Seat", "seat_number"]]),
      ["Class", "booking_class"], ["Status", "", (r) => pill(r.booking_status)], ["Fare", "", (r) => money(r.fare)],
    ], { empty: "This passenger has no bookings yet." }));
};

pages.flights = (id) => {
  view.innerHTML = `<h1>Flights</h1><p class="lede">Search by airport code, then open a flight to see its details, seats and status.</p>
  <section class="panel"><form id="fs" class="row" style="align-items:end">
    <label>From (airport code)<input name="src" maxlength="4" placeholder="DEL"></label>
    <label>To (airport code)<input name="dest" maxlength="4" placeholder="BOM"></label>
    <div class="actions"><button type="submit">Search flights</button><button type="button" class="ghost" id="all">Show all</button></div></form>
    <div class="result" id="fsR" style="display:block"></div></section>
  <div id="detail"></div>`;
  const list = (rows) => {
    $("#fsR").innerHTML = table(rows, [
      ["ID", "flight_id"], ["Flight", "", (r) => `<b>${esc(r.flight_number)}</b>`], ["Airline", "airline_name"],
      ["Route", "", (r) => `${esc(r.src)} → ${esc(r.dest)}`], ["Departs", "", (r) => esc(when(r.departure_time))],
      ["Status", "", (r) => pill(r.status)],
    ], { click: true, empty: "No flights on that route." });
    onRows($("#fsR"), rows, (r) => (location.hash = "#/flights/" + r.flight_id));
  };
  const showAll = () => api("/flights").then(list).catch((e) => ($("#fsR").innerHTML = `<div class="msg err">${esc(e.message)}</div>`));
  $("#all").onclick = showAll;
  $("#fs").onsubmit = (e) => {
    e.preventDefault();
    const { src, dest } = Object.fromEntries(new FormData(e.target));
    if (!src.trim() || !dest.trim()) return showAll();
    api(`/flights/search?src=${encodeURIComponent(src)}&dest=${encodeURIComponent(dest)}`).then(list).catch((e) => ($("#fsR").innerHTML = `<div class="msg err">${esc(e.message)}</div>`));
  };
  showAll();
  if (id) flightDetail(id);
};

async function flightDetail(id) {
  const box = $("#detail");
  box.innerHTML = `<section class="panel" style="margin-top:20px"><p class="empty">Loading flight ${esc(id)}…</p></section>`;
  try {
    const [f, seats] = await Promise.all([api("/flights/" + id), api(`/flights/${id}/seats`)]);
    const free = seats.filter((s) => s.seat_status === "AVAILABLE").length;
    box.innerHTML = `<div class="grid cols-2" style="margin-top:20px">
      <section class="panel"><h2>${esc(f.flight_number)} · ${esc(f.src)} → ${esc(f.dest)}</h2>
        ${kv([["Flight ID", f.flight_id], ["Airline", f.airline_name], ["From", `${f.src} – ${f.src_name}`], ["To", `${f.dest} – ${f.dest_name}`], ["Departs", when(f.departure_time)], ["Arrives", when(f.arrival_time)], ["Aircraft", [f.manufacturer, f.model].filter(Boolean).join(" ") || "Not assigned"], ["Registration", f.registration || "-"], ["Seats", `${free} free of ${seats.length}`], ["Status", pill(f.status), true]])}
        <form id="st" class="card-sep"><label>Update status
          <select name="status">${["SCHEDULED", "DELAYED", "BOARDING", "CANCELLED", "COMPLETED"].map((s) => `<option ${s === f.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <div class="actions"><button type="submit">Update status</button><a href="#/bookings/${f.flight_id}"><button type="button" class="ink">Book a seat</button></a></div></form>
        <div class="result" id="stR"></div></section>
      <section class="panel"><h2>Seat map</h2><div id="sm"></div></section></div>`;
    $("#sm").appendChild(seats.length ? seatMap(seats) : Object.assign(document.createElement("p"), { className: "empty", textContent: "No seats are set up for this flight's aircraft." }));
    wire($("#st"), $("#stR"), (d) => api(`/flights/${id}/status`, "PATCH", d), (r) => ok(r.message));
    $("#stR").addEventListener("rendered", () => flightDetail(id).then(() => toast("Flight status updated")));
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    box.innerHTML = `<div class="msg err" style="margin-top:20px">${esc(e.message)}</div>`;
  }
}

pages.bookings = (preFlight) => {
  view.innerHTML = `<h1>Bookings</h1><p class="lede">Reserve a seat, then look up or cancel a booking.</p>
  <section class="panel"><h2>New booking</h2>
    <form id="nb">
      <div class="row"><label>Passenger ID<input name="passenger_id" type="number" min="1" required></label>
        <label>Flight ID<input name="flight_id" id="fid" type="number" min="1" required value="${esc(preFlight || "")}"></label>
        <label>Class<select name="booking_class"><option>ECONOMY</option><option>PREMIUM_ECONOMY</option><option>BUSINESS</option><option>FIRST</option></select></label>
        <label>Fare (Rs.)<input name="fare" type="number" min="0" step="0.01" required></label></div>
      <div class="actions"><button type="button" class="ink" id="loadSeats">Show seats for this flight</button></div>
      <div id="sm"></div>
      <label style="max-width:200px">Seat ID<input name="seat_id" id="sid" type="number" min="1" required placeholder="Pick on the map"></label>
      <div class="actions"><button type="submit">Create booking</button></div></form>
    <div class="result" id="nbR"></div></section>
  <div class="grid cols-2">
    <section class="panel"><h2>Find a booking</h2>
      <form id="vb" class="row" style="align-items:end"><label>Booking ID<input name="id" type="number" min="1" required></label><div class="actions"><button type="submit">View booking</button></div></form>
      <div class="result" id="vbR"></div></section>
    <section class="panel"><h2>Cancel a booking</h2>
      <form id="cb"><label>Booking ID<input name="id" type="number" min="1" required></label>
        <label>Reason<input name="reason" required placeholder="e.g. Change of plans"></label>
        <div class="actions"><button type="submit" class="ink">Cancel booking</button></div></form>
      <div class="result" id="cbR"></div></section></div>`;
  const loadSeats = async () => {
    const f = $("#fid").value;
    if (!f) return ($("#sm").innerHTML = '<p class="empty">Enter a flight ID first.</p>');
    try {
      const seats = await api(`/flights/${f}/seats`);
      $("#sm").replaceChildren(seats.length ? seatMap(seats, { pick: (s) => { $("#sid").value = s.id; toast("Seat " + s.num + " selected"); } }) : Object.assign(document.createElement("p"), { className: "empty", textContent: "No seats found for that flight." }));
    } catch (e) { $("#sm").innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  $("#loadSeats").onclick = loadSeats;
  if (preFlight) loadSeats();
  wire($("#nb"), $("#nbR"), (d) => api("/bookings", "POST", d), (r) => ok(`Booking created. Booking ID: ${r.booking_id}. Taking you to payment…`));
  // After a successful booking, go straight to the Payments page with the booking pre-loaded.
  $("#nbR").addEventListener("rendered", (e) => {
    toast("Booking #" + e.detail.booking_id + " created. Complete payment to finish.");
    location.hash = "#/payments/" + e.detail.booking_id;
  });
  wire($("#vb"), $("#vbR"), (d) => api("/bookings/" + d.id), (b) =>
    kv([["Booking ID", b.booking_id], ["Status", pill(b.booking_status), true], ["Booked on", when(b.booking_date)], ["Class", b.booking_class], ["Fare", money(b.fare)],
      ["Passenger", `${b.first_name} ${b.last_name} (ID ${b.passenger_id})`], ["Contact", `${b.email} / ${b.phone}`],
      ["Flight", `${b.flight_number}, ${b.src} → ${b.dest}`], ["Departs", when(b.departure_time)], ["Arrives", when(b.arrival_time)], ["Flight status", pill(b.flight_status), true], ["Seat", b.seat_number || "-"]]));
  wire($("#cb"), $("#cbR"), (d) => api(`/bookings/${d.id}/cancel`, "POST", { reason: d.reason }), (r) => ok(r.message));
};

pages.payments = (preBooking) => {
  view.innerHTML = `<h1>Payments</h1><p class="lede">Record a payment for a confirmed booking, or refund a cancelled one. These are database records only; no payment gateway is connected.</p>
  <div class="grid cols-2">
    <section class="panel"><h2>Take payment</h2>
      <div id="payCtx"></div>
      <form id="pay"><label>Booking ID<input name="booking_id" id="pbid" type="number" min="1" required value="${esc(preBooking || "")}"></label>
        <label>Method<select name="method"><option>UPI</option><option>CARD</option><option>NETBANKING</option><option>CASH</option></select></label>
        <div class="actions"><button type="submit">Record payment</button></div></form><div class="result" id="payR"></div></section>
    <section class="panel"><h2>Refund a cancellation</h2>
      <form id="rf"><label>Booking ID<input name="booking_id" type="number" min="1" required></label>
        <label>Refund amount (Rs.)<input name="refund_amount" type="number" min="0" step="0.01" required></label>
        <div class="actions"><button type="submit">Issue refund</button></div></form><div class="result" id="rfR"></div></section></div>`;
  const showBooking = async (id) => {
    if (!id) return ($("#payCtx").innerHTML = "");
    try {
      const b = await api("/bookings/" + id);
      $("#payCtx").innerHTML = `<div class="card-sep" style="margin-bottom:14px">${kv([["Booking", "#" + b.booking_id + " · " + b.booking_status], ["Passenger", `${b.first_name} ${b.last_name}`], ["Flight", `${b.flight_number}, ${b.src} → ${b.dest}`], ["Seat", b.seat_number || "-"], ["Amount due", money(b.fare)]])}</div>`;
    } catch (e) { $("#payCtx").innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  showBooking(preBooking);
  $("#pbid").addEventListener("change", (e) => showBooking(e.target.value));
  wire($("#pay"), $("#payR"), (d) => api("/payments", "POST", d), (r) => `<div class="msg ok">${esc(r.message)}</div>${kv([["Amount", money(r.amount)], ["Transaction ID", r.transaction_id], ["Status", pill(r.status), true]])}`);
  wire($("#rf"), $("#rfR"), (d) => api("/refunds", "POST", d), (r) => `<div class="msg ok">${esc(r.message)}</div>${kv([["Amount", money(r.amount)], ["Reference", r.reference], ["Status", pill(r.status), true]])}`);
};

pages.baggage = () => {
  view.innerHTML = `<h1>Baggage</h1><p class="lede">Tag a bag to a booking, or track one by its tag number.</p>
  <div class="grid cols-2">
    <section class="panel"><h2>Add baggage</h2>
      <form id="ab"><div class="row"><label>Booking ID<input name="booking_id" type="number" min="1" required></label>
        <label>Bag tag number<input name="bag_tag_no" required></label></div>
        <div class="row"><label>Weight (kg)<input name="weight" type="number" min="0" step="0.1" required></label>
        <label>Type<select name="baggage_type"><option>CHECKED</option><option>CABIN</option></select></label></div>
        <div class="actions"><button type="submit">Add baggage</button></div></form><div class="result" id="abR"></div></section>
    <section class="panel"><h2>Track baggage</h2>
      <form id="tb"><label>Bag tag number<input name="tag" required></label>
        <div class="actions"><button type="submit">Track bag</button></div></form><div class="result" id="tbR"></div></section></div>`;
  wire($("#ab"), $("#abR"), (d) => api("/baggage", "POST", d), (r) => ok(`Baggage added. Baggage ID: ${r.baggage_id}`));
  wire($("#tb"), $("#tbR"), (d) => api("/baggage/" + encodeURIComponent(d.tag)), (b) =>
    kv([["Tag", b.bag_tag_no], ["Status", pill(b.baggage_status), true], ["Type", b.baggage_type], ["Weight", b.weight + " kg"], ["Booking", "#" + b.booking_id], ["Passenger", `${b.first_name} ${b.last_name}`], ["Flight", b.flight_number]]));
};

const planeSvg = '<svg viewBox="0 0 44 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M0 10h40M34 3l8 7-8 7"/></svg>';
function boardingPass(p) {
  return `<div class="pass"><div class="main">
    <div><small>Passenger</small><b style="font-size:22px">${esc(p.passenger)}</b></div>
    <div class="path"><span>${esc(p.src)}</span>${planeSvg}<span>${esc(p.dest)}</span></div>
    <div class="meta"><div><small>Flight</small><b>${esc(p.flight)}</b></div><div><small>Departs</small><b>${esc(when(p.departure))}</b></div><div><small>Gate</small><b>${esc(p.gate)}</b></div><div><small>Group</small><b>${esc(p.boarding_group)}</b></div></div></div>
    <div class="stub"><div><small>Seat</small><div class="seatno">${esc(p.seat || "-")}</div></div><div class="bars"></div><code>${esc(p.barcode)}</code></div></div>`;
}

pages.checkin = () => {
  view.innerHTML = `<h1>Check-in</h1><p class="lede">Check a passenger in first. The boarding pass is available once they're checked in.</p>
  <div class="grid cols-2">
    <section class="panel"><h2>Check in a passenger</h2>
      <form id="ci"><label>Booking ID<input name="booking_id" type="number" min="1" required></label>
        <label>Method<select name="method"><option>ONLINE</option><option>COUNTER</option><option>KIOSK</option></select></label>
        <div class="actions"><button type="submit">Check in</button></div></form><div class="result" id="ciR"></div></section>
    <section class="panel"><h2>Boarding pass</h2>
      <form id="bp"><label>Booking ID<input name="booking_id" type="number" min="1" required></label>
        <div class="row"><label>Gate<input name="gate" required placeholder="A12"></label><label>Boarding group<input name="boarding_group" required placeholder="2"></label></div>
        <div class="actions"><button type="submit">Generate boarding pass</button></div></form><div class="result" id="bpR"></div></section></div>`;
  wire($("#ci"), $("#ciR"), (d) => api("/checkin", "POST", d), (r) => ok(`${r.message} Check-in ID: ${r.checkin_id}`));
  wire($("#bp"), $("#bpR"), (d) => api("/boarding-pass", "POST", d), (p) => `${ok(p.message)}${boardingPass(p)}<div class="actions" style="margin-top:14px"><button type="button" class="ghost" onclick="window.print()">Print pass</button></div>`);
};

/* ---------- router ---------- */
function route() {
  const [, page = "dashboard", arg] = location.hash.split("/");
  const fn = pages[page] || pages.dashboard;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#/" + (pages[page] ? page : "dashboard")));
  fn(arg);
  window.scrollTo(0, 0);
}
addEventListener("hashchange", route);
route();

api("/health").then(
  (h) => { const d = $("#db"); d.className = "db ok"; d.lastElementChild.textContent = "Connected to " + h.database; },
  (e) => { const d = $("#db"); d.className = "db bad"; d.lastElementChild.textContent = "Database offline"; d.title = e.message; }
);
