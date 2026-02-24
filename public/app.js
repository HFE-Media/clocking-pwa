// ================== CONFIG ==================
// Put your Supabase Project URL and ANON key here (Supabase -> Project Settings -> API)
const SUPABASE_URL = "https://tevpwavxrsaawnmlgpra.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRldnB3YXZ4cnNhYXdubWxncHJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4ODk5ODIsImV4cCI6MjA4NzQ2NTk4Mn0.3xx7L3q_3cRXUodtpnMJsp6SbvXdoXoG5fGCIj_NQIg";

// Accuracy rule (matches the SQL function example)
const MAX_ACCURACY_M = 100;

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ================== UI HELPERS ==================
let qr = null;
let scanning = false;

const employees = new Map(); // employeeId -> fullName

function $(id){ return document.getElementById(id); }

function setStatus(msg, ok=false){
  const s = $("status");
  s.className = ok ? "ok" : "bad";
  s.textContent = msg;
}
function setMeta(m){ $("meta").textContent = m || ""; }

function setDebug(text){
  const el = $("debug");
  if (!text) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "block";
  el.textContent = text;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function renderList(){
  $("count").textContent = String(employees.size);
  const list = $("list");
  list.innerHTML = "";

  if (employees.size === 0) {
    list.innerHTML = '<small class="muted">No employees scanned yet.</small>';
    return;
  }

  for (const [id, name] of employees.entries()) {
    const div = document.createElement("div");
    div.className = "item";

    const left = document.createElement("div");
    left.innerHTML = `<b>${escapeHtml(name)}</b><br/><small class="muted">${escapeHtml(id)}</small>`;

    const btn = document.createElement("button");
    btn.className = "btnSmall";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      employees.delete(id);
      renderList();
    });

    div.appendChild(left);
    div.appendChild(btn);
    list.appendChild(div);
  }
}

function renderBatchResults(results){
  const out = $("batchResults");
  out.innerHTML = "";
  if (!results || results.length === 0) return;

  for (const r of results) {
    const div = document.createElement("div");
    div.className = "item";
    const status = r.ok ? "OK" : "BLOCKED";
    div.innerHTML = `
      <div>
        <b>${escapeHtml(r.employeeName || r.employeeId)}</b><br/>
        <small class="muted">${escapeHtml(r.employeeId)} — ${escapeHtml(status)} — ${escapeHtml(r.message || "")}</small>
      </div>
    `;
    out.appendChild(div);
  }
}

// ================== DATA LOAD ==================
async function loadSites(selectSiteId=null){
  setStatus("Loading sites…", true);
  setMeta("");

  const { data, error } = await supabase
    .from("sites")
    .select("site_id,name,active")
    .eq("active", true)
    .order("name", { ascending: true });

  const sel = $("siteSelect");
  sel.innerHTML = '<option value="">-- Select a site --</option>';

  if (error) {
    setStatus("Failed to load sites: " + error.message, false);
    return;
  }

  if (!data || data.length === 0) {
    sel.innerHTML = '<option value="">No active sites configured</option>';
    setStatus("No active sites configured.", false);
    return;
  }

  for (const s of data) {
    const opt = document.createElement("option");
    opt.value = s.site_id;
    opt.textContent = `${s.name} (${s.site_id})`;
    sel.appendChild(opt);
  }

  if (selectSiteId) sel.value = selectSiteId;

  setStatus("Ready.", true);
}

// ================== CAMERA / QR ==================
function showCameraError(e, stage){
  const name = e?.name || "UnknownError";
  const msg = e?.message || String(e || "");
  const full = `${name}: ${msg}`;
  const denied = name === "NotAllowedError" || /Permission denied/i.test(full);

  if (denied) {
    setStatus("Camera permission blocked. Use Manual Employee ID OR fix browser permission.", false);
    setMeta("Tip: open in Chrome (not WhatsApp browser). Clear site settings if stuck.");
  } else {
    setStatus("Camera failed (" + (stage || "unknown") + "): " + full, false);
    setMeta("Camera debug → " + full);
  }

  setDebug(
    "Camera failure details\n" +
    "----------------------\n" +
    "Stage: " + (stage || "unknown") + "\n" +
    "Error: " + full + "\n\n" +
    (denied
      ? "Fix:\n- Open in Google Chrome\n- Android Settings → Apps → Chrome → Permissions → Camera → Allow\n- Chrome → Site settings → this site → Clear & reset\n"
      : "Tips:\n- Close other apps using camera\n- Restart phone\n")
  );
}

async function warmUpCameraPermission_() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera API not supported in this browser.");
  }

  // Prefer rear camera for warm-up
  const constraints = {
    video: { facingMode: { ideal: "environment" } },
    audio: false
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  stream.getTracks().forEach(t => t.stop());
}

function ensureScannerInstance() {
  if (!qr) qr = new Html5Qrcode("reader");
}

function onScanFailure(_err) {
  // ignore per-frame decode errors
}

async function addEmployeeById_(scannedId){
  const scanned = String(scannedId || "").trim();
  if (!scanned) return;

  setStatus("Checking employee…", true);

  const { data, error } = await supabase
    .from("employees")
    .select("employee_id,full_name,active")
    .eq("employee_id", scanned)
    .maybeSingle();

  if (error) {
    setStatus("Employee lookup error: " + error.message, false);
    return;
  }

  if (!data || data.active !== true) {
    setStatus("Employee not found or inactive: " + scanned, false);
    return;
  }

  const realId = String(data.employee_id).trim();
  const name = String(data.full_name || "").trim() || realId;

  if (employees.has(realId)) {
    setStatus("Already scanned: " + name, true);
    return;
  }

  employees.set(realId, name);
  renderList();
  setStatus("Added: " + name, true);
}

function onScanSuccess(txt) {
  // fire and forget (don’t block scanning loop)
  addEmployeeById_(txt).catch(err => setStatus("Lookup failed: " + (err?.message || err), false));
}

async function startScanning() {
  if (scanning) return;

  setDebug("");
  setStatus("Requesting camera permission…", true);
  ensureScannerInstance();
  scanning = true;

  try {
    await warmUpCameraPermission_();
  } catch (e) {
    scanning = false;
    showCameraError(e, "permission warm-up");
    return;
  }

  setStatus("Starting scanner…", true);
  const config = { fps: 10, qrbox: 250 };

  try {
    await qr.start({ facingMode: { exact: "environment" } }, config, onScanSuccess, onScanFailure);
    setStatus("Scanner started (rear camera).", true);
    return;
  } catch (_e1) {}

  try {
    await qr.start({ facingMode: "environment" }, config, onScanSuccess, onScanFailure);
    setStatus("Scanner started (rear camera).", true);
    return;
  } catch (_e2) {}

  try {
    await qr.start({ facingMode: "user" }, config, onScanSuccess, onScanFailure);
    setStatus("Scanner started (fallback camera).", true);
    return;
  } catch (e3) {
    scanning = false;
    showCameraError(e3, "all fallbacks failed");
  }
}

async function stopScanning(){
  if (!qr) return;
  try {
    if (scanning) await qr.stop().catch(()=>{});
    await qr.clear().catch(()=>{});
  } catch(_) {}
  qr = null;
  scanning = false;
  setStatus("Scanner stopped.", true);
}

// Manual fallback
async function addManualEmployee(){
  const val = $("manualEmp").value.trim();
  if (!val) return setStatus("Enter an Employee ID.", false);
  $("manualEmp").value = "";
  await addEmployeeById_(val);
}

function clearList(){
  employees.clear();
  renderList();
  $("batchResults").innerHTML = "";
  setDebug("");
}

// Diagnostics
async function runCameraDiagnostics() {
  setDebug("");
  setStatus("Running camera diagnostics…", true);

  const report = [];
  report.push("Camera diagnostics");
  report.push("------------------");
  report.push("UA: " + navigator.userAgent);

  const hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  report.push("mediaDevices.getUserMedia: " + (hasMedia ? "YES" : "NO"));

  if (navigator.permissions && navigator.permissions.query) {
    try {
      const p = await navigator.permissions.query({ name: "camera" });
      report.push("permissions.camera state: " + p.state);
    } catch (e) {
      report.push("permissions.camera state: (query failed) " + (e?.message || e));
    }
  } else {
    report.push("permissions API: NOT SUPPORTED");
  }

  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === "videoinput");
      report.push("video inputs found: " + cams.length);
      cams.forEach((c, i) => report.push(`  cam[${i}]: label="${c.label || "(no label)"}"`));
    } catch (e) {
      report.push("enumerateDevices failed: " + (e?.name || "") + " " + (e?.message || e));
    }
  } else {
    report.push("enumerateDevices: NOT SUPPORTED");
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    report.push("getUserMedia result: SUCCESS ✅");
    stream.getTracks().forEach(t => t.stop());
    setStatus("Diagnostics: Camera is accessible ✅", true);
  } catch (e) {
    report.push("getUserMedia result: FAIL ❌");
    report.push("error.name: " + (e?.name || "unknown"));
    report.push("error.message: " + (e?.message || String(e)));
    setStatus("Diagnostics: Camera blocked ❌ (" + (e?.name || "UnknownError") + ")", false);
  }

  setDebug(report.join("\n"));
}

// ================== GPS + CLOCKING ==================
function getLocation(){
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("Geolocation not supported"));

    // high accuracy attempt, then fallback
    navigator.geolocation.getCurrentPosition(
      res,
      () => navigator.geolocation.getCurrentPosition(
        res, rej,
        { enableHighAccuracy:false, timeout:15000, maximumAge:0 }
      ),
      { enableHighAccuracy:true, timeout:15000, maximumAge:0 }
    );
  });
}

async function clockBatch(action){
  const sup = $("supCode").value.trim();
  const siteId = $("siteSelect").value;

  if (!siteId) return setStatus("Select a site first.", false);
  if (!sup) return setStatus("Enter supervisor code.", false);
  if (employees.size === 0) return setStatus("Scan/add at least 1 employee first.", false);

  setStatus("Getting GPS…", true);
  setMeta("");
  $("batchResults").innerHTML = "";

  let pos;
  try { pos = await getLocation(); }
  catch(e){
    return setStatus("Location failed. Enable GPS + allow permission.", false);
  }

  const accuracyM = Math.round(pos.coords.accuracy || 9999);
  if (!Number.isFinite(accuracyM) || accuracyM > MAX_ACCURACY_M) {
    return setStatus(`Location accuracy too low (${accuracyM}m). Move outside & try again.`, false);
  }

  setStatus("Submitting batch…", true);

  const payload = {
    p_action: action,
    p_supervisor_code: sup,
    p_site_id: siteId,
    p_lat: pos.coords.latitude,
    p_lon: pos.coords.longitude,
    p_accuracy_m: accuracyM,
    p_employee_ids: Array.from(employees.keys())
  };

  const { data, error } = await supabase.rpc("clock_batch", payload);

  if (error) {
    setStatus("Server error: " + error.message, false);
    setDebug("RPC error\n---------\n" + JSON.stringify(error, null, 2));
    return;
  }

  const ok = !!data?.ok;
  setStatus(data?.message || "Done.", ok);

  if (data?.site) {
    setMeta(`Site: ${data.site.Name} | Distance: ${Math.round(data.distanceM || 0)}m | Accuracy: ${accuracyM}m`);
  } else {
    setMeta(`Accuracy: ${accuracyM}m`);
  }

  renderBatchResults(data?.results || []);

  if (ok) {
    employees.clear();
    renderList();
  }
}

// expose functions to HTML buttons
window.startScanning = startScanning;
window.stopScanning = stopScanning;
window.addManualEmployee = addManualEmployee;
window.clearList = clearList;
window.clockBatch = clockBatch;
window.runCameraDiagnostics = runCameraDiagnostics;

// init
renderList();
loadSites().catch(err => setStatus("Init error: " + (err?.message || err), false));