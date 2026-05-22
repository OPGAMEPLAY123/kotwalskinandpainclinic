// ================================================================
//  KSP CLINIC — USER PANEL  app.js  (FIXED)
//  Fixes applied:
//    1. submitOnline() null-ref crash (onlineFormData cleared before use)
//    2. Loader never hides — 6-second hard timeout added
//    3. Jitsi loaded lazily (on demand) with full try/catch
//    4. onAuthStateChanged wrapped in error handler
//    5. All Firebase ops have per-operation error handling
//    6. goToPage() never crashes (defensive element checks)
//    7. listenAppointments() handles Firestore permission errors gracefully
//    8. saveUser() failure is silent (non-blocking)
//    9. Page-switch is instant (no heavy DOM blocking)
// ================================================================

// ── Firebase init ────────────────────────────────────────────────
var firebaseConfig = {
  apiKey:            "AIzaSyDyFDmfg1s-1RgOEWiCmt0pTO43Um6NxXQ",
  authDomain:        "kotwal-skin-and-pain.firebaseapp.com",
  projectId:         "kotwal-skin-and-pain",
  storageBucket:     "kotwal-skin-and-pain.appspot.com",
  messagingSenderId: "461562185631",
  appId:             "1:461562185631:web:5f3b763edffa94bf80dfaa"
};

try {
  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
} catch (e) {
  console.error("Firebase init failed:", e);
  // Show a non-blocking error so the user knows something went wrong
  window.addEventListener("DOMContentLoaded", function () {
    toast("Firebase failed to load. Check your connection.", "error");
    hideLoader();
  });
}

var auth    = firebase.auth    ? firebase.auth()      : null;
var db      = firebase.firestore ? firebase.firestore() : null;
var storage = firebase.storage  ? firebase.storage()   : null;

// ── App State ────────────────────────────────────────────────────
var currentUser    = null;
var apptUnsub      = null;
var lastBookedId   = null;
var jitsiAPI       = null;
var onlineFormData = null;   // holds Step-1 data until Step-2 submits
var loaderTimer    = null;   // fallback timeout handle

// ── DOM shortcut ─────────────────────────────────────────────────
var $ = function (id) { return document.getElementById(id); };

// ================================================================
//  LOADER  (bulletproof: always hides within 6 seconds max)
// ================================================================
function showLoader() {
  var el = $("loader");
  if (!el) return;
  el.classList.remove("hidden");

  // Safety net: auto-hide after 6 s no matter what
  clearTimeout(loaderTimer);
  loaderTimer = setTimeout(function () {
    hideLoader();
    console.warn("KSP: Loader force-hidden after timeout");
  }, 6000);
}

function hideLoader() {
  clearTimeout(loaderTimer);
  var el = $("loader");
  if (!el) return;
  el.classList.add("hidden");
}

// ================================================================
//  TOAST
// ================================================================
var toastTimer = null;
function toast(msg, type) {
  var t = $("toast");
  if (!t) return;
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.className   = "toast " + (type || "") + " show";
  toastTimer = setTimeout(function () {
    t.classList.remove("show");
  }, 3400);
}

// ── Utilities ────────────────────────────────────────────────────
function esc(s) {
  return String(s || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }

// ================================================================
//  AUTH
// ================================================================
// Show loader immediately while we wait for Firebase to resolve auth
showLoader();

if (auth) {
  auth.onAuthStateChanged(
    function (user) {
      if (user) {
        currentUser = user;
        saveUser(user);       // non-blocking, fire-and-forget
        initApp(user);
      } else {
        currentUser = null;
        var ls = $("loginScreen");
        var as = $("appScreen");
        if (ls) ls.classList.add("active");
        if (as) as.classList.remove("active");
        hideLoader();
      }
    },
    function (err) {
      // onAuthStateChanged itself errored (very rare, e.g. network offline)
      console.error("Auth state error:", err);
      hideLoader();
      toast("Authentication error. Please refresh.", "error");
    }
  );
} else {
  hideLoader();
  toast("Firebase Auth unavailable.", "error");
}

// ── Google Login Button ───────────────────────────────────────────
var googleBtn = $("googleLoginBtn");
if (googleBtn) {
  googleBtn.addEventListener("click", function () {
    if (!auth) { toast("Auth not ready. Refresh the page.", "error"); return; }
    showLoader();
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
      .catch(function (e) {
        hideLoader();
        var msg = e.code === "auth/popup-closed-by-user"
          ? "Login cancelled."
          : "Login failed: " + e.message;
        toast(msg, "error");
      });
  });
}

// ── Save user to Firestore (non-blocking) ─────────────────────────
function saveUser(u) {
  if (!db) return;
  db.collection("users").doc(u.uid).set({
    uid:      u.uid,
    name:     u.displayName || "User",
    email:    u.email,
    photoURL: u.photoURL || "",
    loginAt:  firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(function (e) {
    console.warn("saveUser failed (non-critical):", e.message);
  });
}

// ── Logout ───────────────────────────────────────────────────────
function doLogout() {
  if (!auth) return;
  showLoader();
  if (apptUnsub) { try { apptUnsub(); } catch (e) {} apptUnsub = null; }
  disposeJitsi();
  auth.signOut()
    .then(function () { hideLoader(); })
    .catch(function (e) { hideLoader(); toast("Logout error: " + e.message, "error"); });
}

// ── Init App after login ─────────────────────────────────────────
function initApp(u) {
  var ls = $("loginScreen");
  var as = $("appScreen");
  if (ls) ls.classList.remove("active");
  if (as) as.classList.add("active");

  // Avatar
  var ha = $("headerAvatar");
  var pa = $("profileAvatar");
  if (u.photoURL) {
    if (ha) ha.src = u.photoURL;
    if (pa) pa.src = u.photoURL;
  }

  // Profile text
  if ($("profileName"))  $("profileName").textContent  = u.displayName || "User";
  if ($("profileEmail")) $("profileEmail").textContent = u.email || "—";

  // Greeting
  var h = new Date().getHours();
  var g = h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening";
  var firstName = (u.displayName || "").split(" ")[0] || "there";
  if ($("dashGreet")) $("dashGreet").textContent = g + ", " + firstName + "!";

  // Pre-render offline forms
  setOfflineForms(1);

  // Start realtime listener
  listenAppointments(u.uid);

  goToPage("doctor");
  hideLoader();
}

// ================================================================
//  NAVIGATION  (instant, no heavy ops)
// ================================================================
function goToPage(name) {
  // Hide all pages
  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) pages[i].classList.remove("active");

  // Clear all nav active states
  var navBtns = document.querySelectorAll(".nav-btn");
  for (var j = 0; j < navBtns.length; j++) navBtns[j].classList.remove("active");

  // Show requested page
  var pg = $("page-" + name);
  if (pg) pg.classList.add("active");

  // Highlight matching nav button
  var navMap = { doctor: 0, dashboard: 1, offline: 2, online: 3, profile: 4 };
  if (navMap[name] !== undefined && navBtns[navMap[name]]) {
    navBtns[navMap[name]].classList.add("active");
  }

  // Dispose Jitsi if leaving video page
  if (name !== "video" && jitsiAPI) disposeJitsi();
}

// ================================================================
//  OFFLINE APPOINTMENT
// ================================================================
function setCount(n, btn) {
  var btns = document.querySelectorAll(".count-btn");
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove("active");
  if (btn) btn.classList.add("active");
  setOfflineForms(n);
}

function setOfflineForms(n) {
  var c = $("offlineForms");
  if (!c) return;
  var html = "";
  for (var i = 1; i <= n; i++) html += buildPatientForm(i, "off");
  c.innerHTML = html;
}

function buildPatientForm(n, pfx) {
  var slots = [
    "Morning 10:00 AM","Morning 10:30 AM","Morning 11:00 AM","Morning 11:30 AM",
    "Morning 12:00 PM","Morning 12:30 PM","Morning 1:00 PM","Morning 1:30 PM",
    "Evening 6:00 PM","Evening 6:30 PM","Evening 7:00 PM","Evening 7:30 PM",
    "Evening 8:00 PM","Evening 8:30 PM","Evening 9:00 PM","Evening 9:30 PM"
  ];
  var opts  = slots.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join("");
  var today = new Date().toISOString().split("T")[0];
  return (
    '<div class="patient-form-wrap">' +
      '<div class="patient-form-num"><span class="pnum">' + n + '</span> Patient ' + n + '</div>' +
      '<div class="form-group"><label>Full Name *</label>' +
        '<input type="text" id="' + pfx + n + '_name" placeholder="Patient name" autocomplete="off"/></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Age *</label>' +
          '<input type="number" id="' + pfx + n + '_age" placeholder="Age" min="1" max="120"/></div>' +
        '<div class="form-group"><label>Gender *</label>' +
          '<select id="' + pfx + n + '_gender"><option value="">Select</option>' +
          '<option>Male</option><option>Female</option><option>Other</option></select></div>' +
      '</div>' +
      '<div class="form-group"><label>Mobile *</label>' +
        '<input type="tel" id="' + pfx + n + '_mobile" placeholder="10-digit" maxlength="10"/></div>' +
      '<div class="form-group"><label>Email (optional)</label>' +
        '<input type="email" id="' + pfx + n + '_email" placeholder="email optional"/></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Date *</label>' +
          '<input type="date" id="' + pfx + n + '_date" min="' + today + '"/></div>' +
        '<div class="form-group"><label>Time Slot *</label>' +
          '<select id="' + pfx + n + '_slot"><option value="">Select</option>' + opts + '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Symptoms *</label>' +
        '<textarea id="' + pfx + n + '_symp" placeholder="Describe symptoms..."></textarea></div>' +
    '</div>'
  );
}

function getVal(id) {
  var el = $(id);
  return el ? el.value.trim() : "";
}

function submitOffline() {
  if (!currentUser) { toast("Please login first", "error"); return; }
  if (!db) { toast("Database not available. Check connection.", "error"); return; }

  var activeBtn = document.querySelector(".count-btn.active");
  var count     = parseInt(activeBtn ? activeBtn.dataset.n : "1", 10) || 1;
  var patients  = [];
  var pfx       = "off";

  for (var i = 1; i <= count; i++) {
    var name   = getVal(pfx + i + "_name");
    var age    = getVal(pfx + i + "_age");
    var gender = getVal(pfx + i + "_gender");
    var mobile = getVal(pfx + i + "_mobile");
    var email  = getVal(pfx + i + "_email");
    var date   = getVal(pfx + i + "_date");
    var slot   = getVal(pfx + i + "_slot");
    var symp   = getVal(pfx + i + "_symp");

    if (!name || !age || !gender || !mobile || !date || !slot || !symp) {
      toast("Fill all required fields for Patient " + i, "error"); return;
    }
    if (!/^\d{10}$/.test(mobile)) {
      toast("Enter valid 10-digit mobile for Patient " + i, "error"); return;
    }
    patients.push({ name: name, age: age, gender: gender, mobile: mobile,
                    email: email, date: date, slot: slot, symptoms: symp });
  }

  var btn = document.querySelector("#page-offline .submit-btn");
  setBtnLoading(btn, true, "Booking...");

  db.collection("appointments").add({
    appointmentId:     "APT" + Date.now(),
    type:              "offline",
    userUID:           currentUser.uid,
    userName:          currentUser.displayName || "User",
    userEmail:         currentUser.email,
    userPhoto:         currentUser.photoURL || "",
    patients:          patients,
    status:            "pending",
    doctorMessage:     "",
    primaryDate:       patients[0].date,
    primarySlot:       patients[0].slot,
    bookingTimestamp:  firebase.firestore.FieldValue.serverTimestamp()
  }).then(function (ref) {
    lastBookedId = ref.id;
    setBtnLoading(btn, false, '<i class="fa-solid fa-calendar-check"></i> Confirm Booking');
    // Reset form to 1 patient
    setOfflineForms(1);
    var cBtns = document.querySelectorAll(".count-btn");
    for (var k = 0; k < cBtns.length; k++) cBtns[k].classList.remove("active");
    var first = document.querySelector(".count-btn[data-n='1']");
    if (first) first.classList.add("active");
    showStatusScreen("pending", "", patients[0], "offline");
  }).catch(function (e) {
    setBtnLoading(btn, false, '<i class="fa-solid fa-calendar-check"></i> Confirm Booking');
    toast("Booking failed: " + e.message, "error");
    console.error("submitOffline:", e);
  });
}

// ================================================================
//  ONLINE CONSULTATION
// ================================================================
function goToPayment() {
  if (!currentUser) { toast("Please login first", "error"); return; }

  var name   = getVal("on_name");
  var age    = getVal("on_age");
  var gender = getVal("on_gender");
  var mobile = getVal("on_mobile");
  var email  = getVal("on_email");
  var date   = getVal("on_date");
  var slot   = getVal("on_slot");
  var symp   = getVal("on_symptoms");

  if (!name || !age || !gender || !mobile || !email || !date || !slot || !symp) {
    toast("Fill all required fields", "error"); return;
  }
  if (!/^\d{10}$/.test(mobile)) {
    toast("Enter valid 10-digit mobile", "error"); return;
  }

  onlineFormData = { name: name, age: age, gender: gender,
                     mobile: mobile, email: email, date: date,
                     slot: slot, symptoms: symp };

  var s1 = $("onlineStep1");
  var s2 = $("onlineStep2");
  if (s1) s1.style.display = "none";
  if (s2) s2.style.display = "block";
}

function previewScreenshot(input) {
  if (input.files && input.files[0]) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var prev = $("screenshotPreview");
      if (prev) { prev.src = e.target.result; prev.style.display = "block"; }
      var ut = $("uploadText");
      if (ut) ut.textContent = "Screenshot selected ✓";
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function copyUPI() {
  var upiId = "7702392516@fam";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(upiId)
      .then(function () { toast("UPI ID copied!", "success"); })
      .catch(function () { fallbackCopy(upiId); });
  } else {
    fallbackCopy(upiId);
  }
}

function fallbackCopy(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast("UPI ID copied!", "success");
  } catch (e) {
    toast("Copy manually: " + text, "");
  }
}

function submitOnline() {
  if (!currentUser) { toast("Please login first", "error"); return; }
  if (!onlineFormData) { toast("Please fill patient details first", "error"); return; }
  if (!db || !storage) { toast("Database not available. Check connection.", "error"); return; }

  var file = $("paymentScreenshot") && $("paymentScreenshot").files[0];
  if (!file) { toast("Please upload payment screenshot", "error"); return; }

  // ── CRITICAL FIX: capture form data NOW, before any async op clears it ──
  var savedFormData = {
    name:     onlineFormData.name,
    age:      onlineFormData.age,
    gender:   onlineFormData.gender,
    mobile:   onlineFormData.mobile,
    email:    onlineFormData.email,
    date:     onlineFormData.date,
    slot:     onlineFormData.slot,
    symptoms: onlineFormData.symptoms
  };

  var btn = document.querySelector("#onlineStep2 .submit-btn");
  setBtnLoading(btn, true, "Uploading...");

  var storageRef = storage.ref(
    "payment_screenshots/" + currentUser.uid + "_" + Date.now() + "_" + file.name.replace(/\s+/g, "_")
  );

  storageRef.put(file)
    .then(function (snap) { return snap.ref.getDownloadURL(); })
    .then(function (url) {
      return db.collection("appointments").add({
        appointmentId:        "ONLINE" + Date.now(),
        type:                 "online",
        userUID:              currentUser.uid,
        userName:             currentUser.displayName || "User",
        userEmail:            currentUser.email,
        userPhoto:            currentUser.photoURL || "",
        patients:             [savedFormData],
        status:               "payment_uploaded",
        paymentScreenshotURL: url,
        paymentStatus:        "uploaded",
        doctorMessage:        "",
        videoRoomId:          "",
        prescriptionURL:      "",
        primaryDate:          savedFormData.date,
        primarySlot:          savedFormData.slot,
        bookingTimestamp:     firebase.firestore.FieldValue.serverTimestamp()
      });
    })
    .then(function (ref) {
      lastBookedId = ref.id;
      setBtnLoading(btn, false, '<i class="fa-solid fa-paper-plane"></i> Submit Appointment');

      // Reset online form
      resetOnlineForm();

      // ── CRITICAL FIX: use savedFormData (not onlineFormData which is now null) ──
      showStatusScreen("online_pending", "", savedFormData, "online");
    })
    .catch(function (e) {
      setBtnLoading(btn, false, '<i class="fa-solid fa-paper-plane"></i> Submit Appointment');
      toast("Submission failed: " + e.message, "error");
      console.error("submitOnline:", e);
    });

  // Clear global state immediately after capturing — safe now
  onlineFormData = null;
}

function resetOnlineForm() {
  var fields = ["on_name","on_age","on_mobile","on_email","on_date","on_symptoms"];
  fields.forEach(function (id) {
    var el = $(id); if (el) el.value = "";
  });
  var g = $("on_gender"); if (g) g.value = "";
  var s = $("on_slot");   if (s) s.value = "";
  var prev = $("screenshotPreview");
  if (prev) { prev.src = ""; prev.style.display = "none"; }
  var ut = $("uploadText");
  if (ut) ut.textContent = "Tap to upload screenshot";
  var ps = $("paymentScreenshot");
  if (ps) ps.value = "";
  var s1 = $("onlineStep1"); if (s1) s1.style.display = "block";
  var s2 = $("onlineStep2"); if (s2) s2.style.display = "none";
}

// ── Button loading state helper ──────────────────────────────────
function setBtnLoading(btn, loading, labelHtml) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + labelHtml;
  } else {
    btn.innerHTML = labelHtml;
  }
}

// ================================================================
//  REALTIME APPOINTMENT LISTENER
// ================================================================
function listenAppointments(uid) {
  if (!db) return;
  if (apptUnsub) { try { apptUnsub(); } catch (e) {} }

  apptUnsub = db.collection("appointments")
    .where("userUID", "==", uid)
    .orderBy("bookingTimestamp", "desc")
    .onSnapshot(
      function (snap) {
        var all = [];
        snap.forEach(function (d) { all.push(Object.assign({ id: d.id }, d.data())); });
        // Use requestAnimationFrame so renders don't block the main thread
        requestAnimationFrame(function () {
          renderDash(all);
          renderProfile(all);
        });

        // Live-update the status screen if it's open
        if (lastBookedId && $("statusScreen") && $("statusScreen").classList.contains("open")) {
          for (var i = 0; i < all.length; i++) {
            if (all[i].id === lastBookedId) {
              var a  = all[i];
              var p0 = a.patients && a.patients[0] ? a.patients[0] : null;
              if (a.status !== "pending" && a.status !== "payment_uploaded") {
                showStatusScreen(a.status, a.doctorMessage || "", p0, a.type || "offline");
              }
              break;
            }
          }
        }
      },
      function (e) {
        // Listener error (e.g. Firestore rules denied, network down)
        console.error("Appointment listener error:", e.code, e.message);
        if (e.code === "permission-denied") {
          toast("Permission denied to load appointments.", "error");
        } else {
          toast("Connection issue. Pull to refresh.", "error");
        }
      }
    );
}

// ================================================================
//  RENDER DASHBOARD
// ================================================================
function renderDash(list) {
  var pending  = list.filter(function (a) {
    return a.status === "pending" || a.status === "payment_uploaded" || a.status === "pending_approval";
  }).length;
  var approved = list.filter(function (a) { return a.status === "approved"; }).length;
  var online   = list.filter(function (a) { return a.type === "online"; }).length;

  if ($("dsPending"))  $("dsPending").textContent  = pending;
  if ($("dsApproved")) $("dsApproved").textContent = approved;
  if ($("dsOnline"))   $("dsOnline").textContent   = online;

  var c = $("dashList"); if (!c) return;
  if (!list.length) {
    c.innerHTML = '<div class="empty-state"><i class="fa-solid fa-calendar-xmark"></i><p>No appointments yet</p></div>';
    return;
  }
  // Show latest 8 only to keep DOM light
  c.innerHTML = list.slice(0, 8).map(buildApptCard).join("");
}

function renderProfile(list) {
  var c = $("profileList"); if (!c) return;
  if (!list.length) {
    c.innerHTML = '<div class="empty-state"><i class="fa-solid fa-calendar-xmark"></i><p>No appointments found</p></div>';
    return;
  }
  c.innerHTML = list.map(buildApptCard).join("");
}

// ── Appointment card builder ─────────────────────────────────────
function buildApptCard(a) {
  var pts   = a.patients || [];
  var p0    = pts[0] || {};
  var name  = esc(p0.name || "Unknown");
  var extra = pts.length > 1 ? ' <span style="font-size:.72rem;opacity:.6">+' + (pts.length - 1) + ' more</span>' : "";
  var date  = p0.date || "—";
  var slot  = p0.slot || "—";
  var ts    = a.bookingTimestamp && a.bookingTimestamp.toDate ? a.bookingTimestamp.toDate() : null;
  var booked = ts ? ts.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
  var sid   = (a.appointmentId || a.id.slice(-8)).toUpperCase();
  var typeTag = '<span class="appt-type-tag ' + (a.type || "offline") + '">' +
                (a.type === "online" ? "📹 Online" : "🏥 Offline") + '</span>';
  var badge = buildBadge(a.status);

  var extras = "";
  if (a.doctorMessage && (a.status === "approved" || a.status === "rejected")) {
    extras += '<div class="appt-doctor-msg"><i class="fa-solid fa-comment-medical"></i><em> "' +
              esc(a.doctorMessage) + '"</em></div>';
  }
  if (a.type === "online" && a.status === "approved" && a.videoRoomId) {
    extras += '<button class="appt-video-btn" onclick="joinVideoCall(\'' +
              esc(a.id) + '\',\'' + esc(a.videoRoomId) + '\')">' +
              '<i class="fa-solid fa-video"></i> Join Video Consultation</button>';
  }
  if (a.prescriptionURL) {
    extras += '<a href="' + esc(a.prescriptionURL) + '" target="_blank" rel="noopener" class="appt-rx-btn">' +
              '<i class="fa-solid fa-file-medical"></i> Download Prescription</a>';
  }

  return (
    '<div class="appt-card ' + (a.status || "pending") + '">' +
      '<div class="appt-top">' +
        '<div><div class="appt-name">' + name + extra + '</div><div class="appt-id">#' + sid + '</div></div>' +
        badge +
      '</div>' +
      typeTag +
      '<div class="appt-meta">' +
        '<span><i class="fa-solid fa-calendar"></i>' + date + '</span>' +
        '<span><i class="fa-solid fa-clock"></i>' + slot + '</span>' +
        '<span><i class="fa-solid fa-bookmark"></i>' + booked + '</span>' +
      '</div>' + extras +
    '</div>'
  );
}

function buildBadge(status) {
  var labels = {
    pending:           "⏳ Pending",
    payment_uploaded:  "💳 Payment Uploaded",
    pending_approval:  "🔍 Awaiting Approval",
    approved:          "✅ Approved",
    rejected:          "❌ Rejected",
    completed:         "🎯 Completed"
  };
  return '<span class="appt-badge ' + (status || "pending") + '">' +
         (labels[status] || cap(status || "pending")) + '</span>';
}

// ================================================================
//  STATUS SCREEN
// ================================================================
function showStatusScreen(status, msg, patient, type) {
  var el = $("statusScreen");
  if (!el) return;

  var name  = patient ? esc(patient.name || "") : "";
  var date  = patient ? patient.date || "" : "";
  var slot  = patient ? patient.slot || "" : "";
  var strip = name
    ? '<div class="ss-patient-info"><i class="fa-solid fa-user-injured"></i> <strong>' + name + '</strong>' +
      (date ? ' &nbsp;·&nbsp; <i class="fa-solid fa-calendar"></i> ' + date : "") +
      (slot ? ' &nbsp;·&nbsp; <i class="fa-solid fa-clock"></i> ' + slot : "") + '</div>'
    : "";

  var html = "";

  if (status === "pending" || status === "payment_uploaded" || status === "online_pending") {
    var isOnline = (type === "online" || status === "payment_uploaded" || status === "online_pending");
    html =
      '<div class="ss-icon ' + (isOnline ? "ss-online" : "ss-pending") + '">' +
        '<i class="fa-solid ' + (isOnline ? "fa-video" : "fa-hourglass-half") + '"></i></div>' +
      '<h2 class="ss-title">' + (isOnline ? "Consultation Submitted!" : "Appointment Submitted!") + '</h2>' +
      '<div class="ss-bubble ' + (isOnline ? "online" : "pending") + '">' +
        '<div class="ss-status-label ' + (isOnline ? "online" : "pending") + '">' +
          (isOnline ? "📋 PAYMENT UPLOADED" : "⏳ PENDING") + '</div>' +
        '<p class="ss-main-msg">' +
          (isOnline ? "Payment screenshot uploaded. Admin will verify shortly." :
                      "Your appointment is pending confirmation.") + '</p>' +
        '<p class="ss-wait-msg">Please wait <strong>15–30 minutes</strong> and check back here.</p>' +
      '</div>' + strip +
      '<button class="ss-dismiss-btn ' + (isOnline ? "online" : "") + '" onclick="dismissStatus()">' +
        '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard</button>';

  } else if (status === "approved") {
    html =
      '<div class="ss-icon ss-approved"><i class="fa-solid fa-circle-check"></i></div>' +
      '<h2 class="ss-title">Appointment Confirmed!</h2>' +
      '<div class="ss-bubble approved">' +
        '<div class="ss-status-label approved">✅ APPROVED</div>' +
        '<p class="ss-main-msg">Doctor has confirmed your appointment.</p>' +
        (msg ? '<div class="ss-doctor-msg"><i class="fa-solid fa-comment-medical"></i> <em>"' + esc(msg) + '"</em></div>' : "") +
        (type === "online"
          ? '<p class="ss-wait-msg" style="margin-top:10px">Go to <strong>Dashboard</strong> to join your video consultation.</p>' : "") +
      '</div>' + strip +
      '<button class="ss-dismiss-btn approved" onclick="dismissStatus()">' +
        '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard</button>';

  } else if (status === "rejected") {
    html =
      '<div class="ss-icon ss-rejected"><i class="fa-solid fa-circle-xmark"></i></div>' +
      '<h2 class="ss-title">Appointment Rejected</h2>' +
      '<div class="ss-bubble rejected">' +
        '<div class="ss-status-label rejected">❌ REJECTED</div>' +
        '<p class="ss-main-msg">Doctor has rejected this appointment.</p>' +
        (msg ? '<div class="ss-doctor-msg"><i class="fa-solid fa-comment-medical"></i> <em>"' + esc(msg) + '"</em></div>' : "") +
      '</div>' + strip +
      '<button class="ss-dismiss-btn rejected" onclick="dismissStatus()">' +
        '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard</button>';

  } else {
    // Unknown status — generic fallback
    html =
      '<div class="ss-icon ss-pending"><i class="fa-solid fa-hourglass-half"></i></div>' +
      '<h2 class="ss-title">Status: ' + esc(cap(status)) + '</h2>' +
      (msg ? '<p class="ss-main-msg">' + esc(msg) + '</p>' : "") + strip +
      '<button class="ss-dismiss-btn" onclick="dismissStatus()">' +
        '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard</button>';
  }

  $("statusContent").innerHTML = html;
  el.classList.add("open");
}

function dismissStatus() {
  var el = $("statusScreen");
  if (el) el.classList.remove("open");
  goToPage("dashboard");
}

// ================================================================
//  VIDEO CALL (Jitsi — loaded LAZILY)
// ================================================================
var jitsiScriptLoading = false;
var jitsiScriptLoaded  = false;

function loadJitsiScript(callback) {
  if (jitsiScriptLoaded) { callback(); return; }
  if (jitsiScriptLoading) {
    // Already loading — poll until ready (max 15s)
    var waited = 0;
    var poll = setInterval(function () {
      waited += 200;
      if (jitsiScriptLoaded) { clearInterval(poll); callback(); }
      if (waited > 15000) { clearInterval(poll); callback(new Error("Jitsi load timeout")); }
    }, 200);
    return;
  }

  jitsiScriptLoading = true;
  var script   = document.createElement("script");
  script.src   = "https://meet.jit.si/external_api.js";
  script.async = true;
  script.onload = function () {
    jitsiScriptLoaded  = true;
    jitsiScriptLoading = false;
    callback();
  };
  script.onerror = function () {
    jitsiScriptLoading = false;
    callback(new Error("Failed to load Jitsi script"));
  };
  document.head.appendChild(script);
}

function joinVideoCall(apptId, roomId) {
  if (!roomId) { toast("Room not ready yet. Please wait.", "error"); return; }
  goToPage("video");

  var container = $("jitsiContainer");
  if (container) {
    container.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;' +
      'height:100%;color:#aaa;font-size:.9rem;flex-direction:column;gap:10px">' +
      '<i class="fa-solid fa-spinner fa-spin" style="font-size:28px"></i>Connecting…</div>';
  }

  loadJitsiScript(function (err) {
    if (err) {
      toast("Video call unavailable: " + err.message, "error");
      if (container) container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;' +
        'color:#e63946;font-size:.9rem;">Failed to load video. Check your connection.</div>';
      return;
    }

    if (typeof JitsiMeetExternalAPI === "undefined") {
      toast("Jitsi API not available. Try again.", "error"); return;
    }

    disposeJitsi();
    if (!container) return;

    var uname = (currentUser && currentUser.displayName) ? currentUser.displayName : "Patient";

    try {
      jitsiAPI = new JitsiMeetExternalAPI("meet.jit.si", {
        roomName:   "ksp-" + roomId,
        parentNode: container,
        width:      "100%",
        height:     420,
        userInfo:   { displayName: uname },
        configOverwrite: {
          startWithAudioMuted: false,
          startWithVideoMuted: false
        },
        interfaceConfigOverwrite: {
          TOOLBAR_BUTTONS:          ["microphone","camera","hangup","chat","tileview"],
          SHOW_JITSI_WATERMARK:     false,
          SHOW_WATERMARK_FOR_GUESTS: false
        }
      });

      jitsiAPI.addEventListener("videoConferenceLeft", function () { endCall(); });
      jitsiAPI.addEventListener("errorOccurred", function (e) {
        console.error("Jitsi error:", e);
        toast("Video error: " + (e.error || "unknown"), "error");
      });
    } catch (e) {
      console.error("JitsiMeetExternalAPI init failed:", e);
      toast("Could not start video call: " + e.message, "error");
      if (container) container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;' +
        'color:#e63946;font-size:.9rem;">Video failed to start. Please retry.</div>';
      return;
    }

    // Listen for prescription on this appointment
    if (db) {
      db.collection("appointments").doc(apptId).onSnapshot(function (d) {
        if (d.exists) {
          var data = d.data();
          if (data.prescriptionURL) {
            var ps = $("prescriptionSection");
            var pl = $("prescriptionLink");
            if (ps) ps.style.display = "block";
            if (pl) pl.href = data.prescriptionURL;
          }
        }
      }, function (e) {
        console.warn("Prescription listener error:", e.message);
      });
    }
  });
}

function disposeJitsi() {
  if (jitsiAPI) {
    try { jitsiAPI.dispose(); } catch (e) {}
    jitsiAPI = null;
  }
}

function toggleMic() {
  if (!jitsiAPI) { toast("Video call not active", "error"); return; }
  try {
    jitsiAPI.executeCommand("toggleAudio");
    var btn = $("micBtn"); if (!btn) return;
    btn.classList.toggle("off");
    btn.querySelector("i").className = btn.classList.contains("off")
      ? "fa-solid fa-microphone-slash"
      : "fa-solid fa-microphone";
  } catch (e) { console.warn("toggleMic:", e); }
}

function toggleCam() {
  if (!jitsiAPI) { toast("Video call not active", "error"); return; }
  try {
    jitsiAPI.executeCommand("toggleVideo");
    var btn = $("camBtn"); if (!btn) return;
    btn.classList.toggle("off");
    btn.querySelector("i").className = btn.classList.contains("off")
      ? "fa-solid fa-video-slash"
      : "fa-solid fa-video";
  } catch (e) { console.warn("toggleCam:", e); }
}

function endCall() {
  disposeJitsi();
  var container = $("jitsiContainer");
  if (container) {
    container.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;' +
      'color:#fff;font-size:1.1rem;font-weight:600;">' +
      '<i class="fa-solid fa-phone-slash" style="margin-right:10px"></i>Call Ended</div>';
  }
  toast("Call ended", "success");
}

// ================================================================
//  GLOBAL ERROR CATCHER — last-resort safety net
// ================================================================
window.onerror = function (msg, src, line, col, err) {
  console.error("Global error:", msg, src, line, col, err);
  // Hide loader if it's still stuck
  hideLoader();
  // Don't show toast for every minor error — only show for critical ones
  if (msg && (msg.indexOf("Firebase") !== -1 || msg.indexOf("Jitsi") !== -1)) {
    toast("An error occurred. Please refresh if the app freezes.", "error");
  }
  return false; // let the error propagate to console
};

window.addEventListener("unhandledrejection", function (e) {
  console.error("Unhandled promise rejection:", e.reason);
  hideLoader();
});
