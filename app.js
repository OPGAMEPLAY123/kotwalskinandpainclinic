// ================================================================
//  KSP CLINIC — app.js
//  Production-stable for InfinityFree hosting
//  All CDN failures, loader freezes & Firebase errors handled
// ================================================================

/* ── Firebase Config ─────────────────────────────────────────── */
var FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDyFDmfg1s-1RgOEWiCmt0pTO43Um6NxXQ",
  authDomain:        "kotwal-skin-and-pain.firebaseapp.com",
  projectId:         "kotwal-skin-and-pain",
  storageBucket:     "kotwal-skin-and-pain.appspot.com",
  messagingSenderId: "461562185631",
  appId:             "1:461562185631:web:5f3b763edffa94bf80dfaa"
};

/* ── Safe Firebase init ──────────────────────────────────────── */
var auth, db, storage;
try {
  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }
  auth    = firebase.auth();
  db      = firebase.firestore();
  storage = firebase.storage();
  // Enable Firestore offline persistence for better performance
  db.enablePersistence({ synchronizeTabs: true }).catch(function(e) {
    if (e.code !== 'failed-precondition' && e.code !== 'unimplemented') {
      console.warn('Firestore persistence:', e.code);
    }
  });
} catch(e) {
  console.error('Firebase init failed:', e);
  // App will still render — Firebase-dependent features will show errors
}

/* ── State ───────────────────────────────────────────────────── */
var currentUser    = null;
var apptUnsub      = null;
var lastBookedId   = null;
var jitsiAPI       = null;
var jitsiLoaded    = false;  // lazy-load Jitsi only when needed
var onlineFormData = null;
var authResolved   = false;
var loaderTimer    = null;

/* ── DOM helper ─────────────────────────────────────────────── */
var $ = function(id) {
  return document.getElementById(id);
};

/* ═══════════════════════════════════════════════════════════════
   LOADER SYSTEM
   - Starts hidden (HTML has class="loader-overlay hidden")
   - Auto-kills after MAX_LOADER_MS — never stuck forever
   - Every showLoader() call resets the kill timer
═══════════════════════════════════════════════════════════════ */
var MAX_LOADER_MS = 6000; // 6 seconds max — then force-hide

function showLoader() {
  var el = $('loader');
  if (!el) return;
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  // Reset kill timer
  clearTimeout(loaderTimer);
  loaderTimer = setTimeout(function() {
    hideLoader();
    toast('Taking longer than expected — please try again if needed.', '');
  }, MAX_LOADER_MS);
}

function hideLoader() {
  clearTimeout(loaderTimer);
  var el = $('loader');
  if (!el) return;
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
}

/* ═══════════════════════════════════════════════════════════════
   TOAST NOTIFICATION
═══════════════════════════════════════════════════════════════ */
var toastTimer = null;
function toast(msg, type) {
  var t = $('toast');
  if (!t) return;
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.className = 'toast ' + (type || '') + ' show';
  toastTimer = setTimeout(function() {
    t.classList.remove('show');
  }, type === 'error' ? 5000 : 3200);
}

/* ─── Escape HTML ────────────────────────────────────────────── */
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

/* ═══════════════════════════════════════════════════════════════
   STARTUP — Show login immediately, never wait for Firebase
═══════════════════════════════════════════════════════════════ */

// Show login as soon as DOM is ready — instant, no spinner
document.addEventListener('DOMContentLoaded', function() {
  showLoginScreen();
  buildOfflineForms(1); // pre-build forms so they're ready
});

// Hard fallback: if Firebase auth never fires in 5s → show login
var authFallbackTimer = setTimeout(function() {
  if (!authResolved) {
    authResolved = true;
    hideLoader();
    showLoginScreen();
    console.warn('Firebase auth timeout — showing login screen');
  }
}, 5000);

function showLoginScreen() {
  hideLoader();
  var ls = $('loginScreen'), as = $('appScreen');
  if (ls && !ls.classList.contains('active')) {
    ls.classList.add('active');
  }
  if (as) as.classList.remove('active');
}

/* ═══════════════════════════════════════════════════════════════
   FIREBASE AUTH
═══════════════════════════════════════════════════════════════ */
if (auth) {
  auth.onAuthStateChanged(function(user) {
    authResolved = true;
    clearTimeout(authFallbackTimer);

    if (user) {
      currentUser = user;
      try { saveUser(user); } catch(e) { console.warn('saveUser failed:', e); }
      initApp(user);
    } else {
      currentUser = null;
      hideLoader();
      showLoginScreen();
    }
  });
}

/* Google Login Button */
var _loginBtnReady = false;
document.addEventListener('DOMContentLoaded', function() {
  var btn = $('googleLoginBtn');
  if (!btn || _loginBtnReady) return;
  _loginBtnReady = true;
  btn.addEventListener('click', function() {
    if (!auth) {
      toast('Firebase not loaded. Check your internet connection.', 'error');
      return;
    }
    showLoader();
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
      .catch(function(e) {
        hideLoader();
        if (e.code === 'auth/unauthorized-domain') {
          toast('Domain not authorized. Add your domain in Firebase Console → Authentication → Authorized Domains.', 'error');
        } else if (e.code === 'auth/popup-blocked') {
          toast('Popup blocked — please allow popups for this site and try again.', 'error');
        } else if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
          // User closed popup — no error toast needed
        } else if (e.code === 'auth/network-request-failed') {
          toast('Network error — check your internet connection.', 'error');
        } else {
          toast('Login failed: ' + (e.message || 'Unknown error'), 'error');
        }
      });
  });
});

function saveUser(u) {
  if (!db) return;
  db.collection('users').doc(u.uid).set({
    uid:      u.uid,
    name:     u.displayName || 'User',
    email:    u.email,
    photoURL: u.photoURL || '',
    loginAt:  firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(function(e) {
    console.warn('saveUser Firestore error:', e);
  });
}

/* ── Logout ─────────────────────────────────────────────────── */
function doLogout() {
  showLoader();
  if (apptUnsub) { try { apptUnsub(); } catch(e) {} apptUnsub = null; }
  if (jitsiAPI)  { try { jitsiAPI.dispose(); } catch(e) {} jitsiAPI = null; }
  if (auth) {
    auth.signOut()
      .then(function() { hideLoader(); })
      .catch(function() { hideLoader(); });
  } else {
    hideLoader();
    showLoginScreen();
  }
}

/* ── Init App after login ───────────────────────────────────── */
function initApp(u) {
  // Switch screens
  var ls = $('loginScreen'), as = $('appScreen');
  if (ls) ls.classList.remove('active');
  if (as) as.classList.add('active');

  // Set user info
  if (u.photoURL) {
    var ha = $('headerAvatar'), pa = $('profileAvatar');
    if (ha) ha.src = u.photoURL;
    if (pa) pa.src = u.photoURL;
  }
  var pn = $('profileName'),  pe = $('profileEmail');
  if (pn) pn.textContent = u.displayName || 'User';
  if (pe) pe.textContent = u.email || '';

  var h = new Date().getHours();
  var g = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
  var dg = $('dashGreet');
  if (dg) dg.textContent = g + ', ' + (u.displayName || '').split(' ')[0] + '!';

  buildOfflineForms(1);
  listenAppointments(u.uid);
  goToPage('doctor');
  hideLoader();
}

/* ═══════════════════════════════════════════════════════════════
   NAVIGATION — instant, no loader
═══════════════════════════════════════════════════════════════ */
function goToPage(name) {
  // Use requestAnimationFrame to avoid DOM blocking
  requestAnimationFrame(function() {
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) pages[i].classList.remove('active');
    var navBtns = document.querySelectorAll('.nav-btn');
    for (var j = 0; j < navBtns.length; j++) navBtns[j].classList.remove('active');

    var pg = $('page-' + name);
    if (pg) pg.classList.add('active');

    var map = { doctor:0, dashboard:1, offline:2, online:3, profile:4 };
    if (map[name] !== undefined && navBtns[map[name]]) {
      navBtns[map[name]].classList.add('active');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   OFFLINE APPOINTMENT
═══════════════════════════════════════════════════════════════ */
function setCount(n, btn) {
  var btns = document.querySelectorAll('.count-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  if (btn) btn.classList.add('active');
  buildOfflineForms(n);
}

function buildOfflineForms(n) {
  var c = $('offlineForms');
  if (!c) return;
  var html = '';
  for (var i = 1; i <= n; i++) html += buildPatientFormHTML(i, 'off');
  c.innerHTML = html;
}

function buildPatientFormHTML(n, pfx) {
  var slots = [
    'Morning 10:00 AM','Morning 10:30 AM','Morning 11:00 AM','Morning 11:30 AM',
    'Morning 12:00 PM','Morning 12:30 PM','Morning 1:00 PM','Morning 1:30 PM',
    'Evening 6:00 PM','Evening 6:30 PM','Evening 7:00 PM','Evening 7:30 PM',
    'Evening 8:00 PM','Evening 8:30 PM','Evening 9:00 PM','Evening 9:30 PM'
  ];
  var opts = '';
  for (var s = 0; s < slots.length; s++) opts += '<option value="' + slots[s] + '">' + slots[s] + '</option>';
  var today = new Date().toISOString().split('T')[0];
  return (
    '<div class="patient-form-wrap">' +
      '<div class="patient-form-num"><span class="pnum">' + n + '</span> Patient ' + n + '</div>' +
      '<div class="form-group"><label>Full Name *</label>' +
        '<input type="text" id="' + pfx + n + '_name" placeholder="Patient name" autocomplete="name"/></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Age *</label>' +
          '<input type="number" id="' + pfx + n + '_age" placeholder="Age" min="1" max="120" inputmode="numeric"/></div>' +
        '<div class="form-group"><label>Gender *</label>' +
          '<select id="' + pfx + n + '_gender">' +
            '<option value="">Select</option><option>Male</option><option>Female</option><option>Other</option>' +
          '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Mobile *</label>' +
        '<input type="tel" id="' + pfx + n + '_mobile" placeholder="10-digit" maxlength="10" inputmode="numeric"/></div>' +
      '<div class="form-group"><label>Email (optional)</label>' +
        '<input type="email" id="' + pfx + n + '_email" placeholder="email@example.com" autocomplete="email"/></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Date *</label>' +
          '<input type="date" id="' + pfx + n + '_date" min="' + today + '"/></div>' +
        '<div class="form-group"><label>Time Slot *</label>' +
          '<select id="' + pfx + n + '_slot"><option value="">Select</option>' + opts + '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Symptoms *</label>' +
        '<textarea id="' + pfx + n + '_symp" placeholder="Describe symptoms..." rows="3"></textarea></div>' +
    '</div>'
  );
}

function getFieldVal(id) {
  var el = $(id);
  return el ? el.value.trim() : '';
}

function submitOffline() {
  if (!currentUser) { toast('Please login first', 'error'); return; }
  if (!db) { toast('Database not available — check internet', 'error'); return; }

  var activeBtn = document.querySelector('.count-btn.active');
  var count = parseInt(activeBtn ? activeBtn.dataset.n : '1');
  var patients = [];
  var pfx = 'off';

  for (var i = 1; i <= count; i++) {
    var name   = getFieldVal(pfx + i + '_name');
    var age    = getFieldVal(pfx + i + '_age');
    var gender = getFieldVal(pfx + i + '_gender');
    var mobile = getFieldVal(pfx + i + '_mobile');
    var email  = getFieldVal(pfx + i + '_email');
    var date   = getFieldVal(pfx + i + '_date');
    var slot   = getFieldVal(pfx + i + '_slot');
    var symp   = getFieldVal(pfx + i + '_symp');

    if (!name || !age || !gender || !mobile || !date || !slot || !symp) {
      toast('Fill all required fields for Patient ' + i, 'error'); return;
    }
    if (!/^\d{10}$/.test(mobile)) {
      toast('Enter valid 10-digit mobile for Patient ' + i, 'error'); return;
    }
    patients.push({ name:name, age:age, gender:gender, mobile:mobile, email:email, date:date, slot:slot, symptoms:symp });
  }

  var btn = document.querySelector('#page-offline .submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Booking...'; }

  var resetBtn = function() {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-calendar-check"></i> Confirm Booking'; }
  };

  db.collection('appointments').add({
    appointmentId:    'APT' + Date.now(),
    type:             'offline',
    userUID:          currentUser.uid,
    userName:         currentUser.displayName || 'User',
    userEmail:        currentUser.email,
    userPhoto:        currentUser.photoURL || '',
    patients:         patients,
    status:           'pending',
    doctorMessage:    '',
    primaryDate:      patients[0].date,
    primarySlot:      patients[0].slot,
    bookingTimestamp: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function(ref) {
    lastBookedId = ref.id;
    resetBtn();
    buildOfflineForms(1);
    var cbs = document.querySelectorAll('.count-btn');
    for (var i = 0; i < cbs.length; i++) cbs[i].classList.remove('active');
    var first = document.querySelector(".count-btn[data-n='1']");
    if (first) first.classList.add('active');
    showStatusScreen('pending', '', patients[0], 'offline');
  }).catch(function(e) {
    resetBtn();
    toast('Booking failed: ' + (e.message || 'Please try again'), 'error');
    console.error('submitOffline:', e);
  });
}

/* ═══════════════════════════════════════════════════════════════
   ONLINE CONSULTATION
═══════════════════════════════════════════════════════════════ */
function goToPayment() {
  if (!currentUser) { toast('Please login first', 'error'); return; }

  var name   = getFieldVal('on_name');
  var age    = getFieldVal('on_age');
  var gender = getFieldVal('on_gender');
  var mobile = getFieldVal('on_mobile');
  var email  = getFieldVal('on_email');
  var date   = getFieldVal('on_date');
  var slot   = getFieldVal('on_slot');
  var symp   = getFieldVal('on_symptoms');

  if (!name || !age || !gender || !mobile || !email || !date || !slot || !symp) {
    toast('Fill all required fields', 'error'); return;
  }
  if (!/^\d{10}$/.test(mobile)) {
    toast('Enter valid 10-digit mobile', 'error'); return;
  }
  onlineFormData = { name:name, age:age, gender:gender, mobile:mobile, email:email, date:date, slot:slot, symptoms:symp };

  var s1 = $('onlineStep1'), s2 = $('onlineStep2');
  if (s1) s1.style.display = 'none';
  if (s2) s2.style.display = 'block';
}

function previewScreenshot(input) {
  if (input.files && input.files[0]) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var prev = $('screenshotPreview');
      var txt  = $('uploadText');
      if (prev) { prev.src = e.target.result; prev.style.display = 'block'; }
      if (txt)  txt.textContent = 'Screenshot selected ✓';
    };
    reader.onerror = function() {
      toast('Could not read file — try another image', 'error');
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function copyUPI() {
  var upiId = '7702392516@fam';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(upiId).then(function() {
      toast('UPI ID copied!', 'success');
    }).catch(function() {
      // Fallback for older browsers
      fallbackCopy(upiId);
    });
  } else {
    fallbackCopy(upiId);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('UPI ID copied!', 'success');
  } catch(e) {
    toast('Copy manually: ' + text, '');
  }
  document.body.removeChild(ta);
}

function submitOnline() {
  if (!currentUser) { toast('Please login first', 'error'); return; }
  if (!onlineFormData) { toast('Please fill patient details first', 'error'); return; }
  if (!storage || !db) { toast('Service not available — check internet', 'error'); return; }

  var file = $('paymentScreenshot') ? $('paymentScreenshot').files[0] : null;
  if (!file) { toast('Please upload payment screenshot', 'error'); return; }

  // File size check (max 5MB for InfinityFree)
  if (file.size > 5 * 1024 * 1024) {
    toast('Screenshot too large — please use an image under 5MB', 'error'); return;
  }

  var btn = document.querySelector('#onlineStep2 .submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading...'; }

  var resetBtn = function() {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Appointment'; }
  };

  // Cache onlineFormData before async (will be nulled)
  var formData = onlineFormData;

  /* Upload timeout — auto-fail after 30s to prevent infinite loading */
  var uploadTimedOut = false;
  var uploadTimeoutId = setTimeout(function(){
    uploadTimedOut = true;
    resetBtn();
    toast('Upload timed out — check internet connection and try again', 'error');
  }, 30000);

  var storageRef = storage.ref('payment_screenshots/' + currentUser.uid + '_' + Date.now());
  storageRef.put(file)
    .then(function(snap) {
      if(uploadTimedOut) throw new Error('Upload timed out');
      clearTimeout(uploadTimeoutId);
      return snap.ref.getDownloadURL();
    })
    .then(function(url) {
      return db.collection('appointments').add({
        appointmentId:       'ONLINE' + Date.now(),
        type:                'online',
        userUID:             currentUser.uid,
        userName:            currentUser.displayName || 'User',
        userEmail:           currentUser.email,
        userPhoto:           currentUser.photoURL || '',
        patients:            [formData],
        status:              'payment_uploaded',
        paymentScreenshotURL: url,
        paymentStatus:       'uploaded',
        doctorMessage:       '',
        videoRoomId:         '',
        prescriptionURL:     '',
        primaryDate:         formData.date,
        primarySlot:         formData.slot,
        bookingTimestamp:    firebase.firestore.FieldValue.serverTimestamp()
      });
    })
    .then(function(ref) {
      lastBookedId = ref.id;
      resetBtn();
      // Reset fields
      ['on_name','on_age','on_mobile','on_email','on_date','on_symptoms'].forEach(function(id) {
        var el = $(id); if (el) el.value = '';
      });
      var og = $('on_gender'), os = $('on_slot');
      if (og) og.value = ''; if (os) os.value = '';
      var sp = $('screenshotPreview'), ut = $('uploadText'), psi = $('paymentScreenshot');
      if (sp)  { sp.style.display = 'none'; sp.src = ''; }
      if (ut)  ut.textContent = 'Tap to upload screenshot';
      if (psi) psi.value = '';
      var s1 = $('onlineStep1'), s2 = $('onlineStep2');
      if (s1) s1.style.display = 'block';
      if (s2) s2.style.display = 'none';
      onlineFormData = null;
      showStatusScreen('payment_uploaded', '', formData, 'online');
    })
    .catch(function(e) {
      clearTimeout(uploadTimeoutId);
      resetBtn();
      if (e.code === 'storage/unauthorized') {
        toast('Storage not authorized — check Firebase Storage rules', 'error');
      } else if (e.code === 'storage/canceled') {
        toast('Upload cancelled', '');
      } else {
        toast('Upload failed: ' + (e.message || 'Please try again'), 'error');
      }
      console.error('submitOnline:', e);
    });
}

/* ═══════════════════════════════════════════════════════════════
   REAL-TIME FIRESTORE LISTENER
═══════════════════════════════════════════════════════════════ */
function listenAppointments(uid) {
  if (apptUnsub) { try { apptUnsub(); } catch(e) {} apptUnsub = null; }
  if (!db) return;

  apptUnsub = db.collection('appointments')
    .where('userUID', '==', uid)
    .orderBy('bookingTimestamp', 'desc')
    .onSnapshot(function(snap) {
      var all = [];
      snap.forEach(function(d) {
        all.push(Object.assign({ id: d.id }, d.data()));
      });
      renderDash(all);
      renderProfile(all);

      // Update status screen live when admin acts
      var ssEl = $('statusScreen');
      if (lastBookedId && ssEl && ssEl.classList.contains('open')) {
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === lastBookedId) {
            var a = all[i];
            var p0 = a.patients && a.patients[0] ? a.patients[0] : null;
            // Only update if status has progressed past the initial state
            if (a.status !== 'pending' && a.status !== 'payment_uploaded') {
              showStatusScreen(a.status, a.doctorMessage || '', p0, a.type || 'offline');
            }
            break;
          }
        }
      }
    }, function(e) {
      console.error('Appointments listener error:', e);
      // Don't crash — listener will retry automatically
      if (e.code === 'permission-denied') {
        toast('Permission denied — check Firestore rules', 'error');
      }
    });
}

/* ═══════════════════════════════════════════════════════════════
   RENDER DASHBOARD
═══════════════════════════════════════════════════════════════ */
function renderDash(list) {
  var pending  = 0, approved = 0, online = 0;
  for (var i = 0; i < list.length; i++) {
    var s = list[i].status;
    if (s === 'pending' || s === 'payment_uploaded' || s === 'pending_approval') pending++;
    if (s === 'approved') approved++;
    if (list[i].type === 'online') online++;
  }
  var dp = $('dsPending'),  da = $('dsApproved'), do_ = $('dsOnline');
  if (dp) dp.textContent = pending;
  if (da) da.textContent = approved;
  if (do_) do_.textContent = online;

  var c = $('dashList'); if (!c) return;
  if (!list.length) {
    c.innerHTML = '<div class="empty-state"><i class="fa-solid fa-calendar-xmark"></i><p>No appointments yet</p></div>';
    return;
  }
  // Use fragment to avoid multiple repaints
  var html = '';
  var shown = list.slice(0, 8);
  for (var j = 0; j < shown.length; j++) html += buildApptCard(shown[j]);
  c.innerHTML = html;
}

function renderProfile(list) {
  var c = $('profileList'); if (!c) return;
  if (!list.length) {
    c.innerHTML = '<div class="empty-state"><i class="fa-solid fa-calendar-xmark"></i><p>No appointments found</p></div>';
    return;
  }
  var html = '';
  for (var i = 0; i < list.length; i++) html += buildApptCard(list[i]);
  c.innerHTML = html;
}

/* ── Build Appointment Card ─────────────────────────────────── */
function buildApptCard(a) {
  var pts  = a.patients || [];
  var p0   = pts[0] || {};
  var name = esc(p0.name || 'Unknown');
  var extra = pts.length > 1 ? ' <span style="font-size:.72rem;opacity:.6">+' + (pts.length - 1) + ' more</span>' : '';
  var date  = p0.date || '—';
  var slot  = p0.slot || '—';
  var ts    = a.bookingTimestamp && a.bookingTimestamp.toDate ? a.bookingTimestamp.toDate() : null;
  var booked = ts ? ts.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '—';
  var sid   = (a.appointmentId || a.id.slice(-8)).toUpperCase();
  var typ   = a.type === 'online' ? 'online' : 'offline';
  var typeTag = '<span class="appt-type-tag ' + typ + '">' + (typ === 'online' ? '📹 Online' : '🏥 Offline') + '</span>';
  var badge = buildBadge(a.status);

  var extras = '';
  if (a.doctorMessage && (a.status === 'approved' || a.status === 'rejected')) {
    extras += '<div class="appt-doctor-msg"><i class="fa-solid fa-comment-medical"></i><em> &ldquo;' + esc(a.doctorMessage) + '&rdquo;</em></div>';
  }
  if (a.type === 'online' && a.status === 'approved' && a.videoRoomId) {
    extras += '<button class="appt-video-btn" type="button" onclick="joinVideoCall(\'' + esc(a.id) + '\',\'' + esc(a.videoRoomId) + '\')"><i class="fa-solid fa-video"></i> Join Video Consultation</button>';
  }
  if (a.prescriptionURL) {
    extras += '<a href="' + esc(a.prescriptionURL) + '" target="_blank" rel="noopener" class="appt-rx-btn"><i class="fa-solid fa-file-medical"></i> Download Prescription</a>';
  }

  return (
    '<div class="appt-card ' + (a.status || 'pending') + '">' +
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
    pending:           '⏳ Pending',
    payment_uploaded:  '💳 Payment Uploaded',
    pending_approval:  '🔍 Awaiting Approval',
    approved:          '✅ Approved',
    rejected:          '❌ Rejected',
    completed:         '🎯 Completed'
  };
  return '<span class="appt-badge ' + (status || 'pending') + '">' + (labels[status] || cap(status || 'pending')) + '</span>';
}

/* ═══════════════════════════════════════════════════════════════
   STATUS SCREEN
═══════════════════════════════════════════════════════════════ */
function showStatusScreen(status, msg, patient, type) {
  var el = $('statusScreen'); if (!el) return;
  var name = patient ? esc(patient.name || '') : '';
  var date = patient ? (patient.date || '') : '';
  var slot = patient ? (patient.slot || '') : '';

  var strip = name
    ? '<div class="ss-patient-info">' +
        '<i class="fa-solid fa-user-injured"></i> <strong>' + name + '</strong>' +
        (date ? ' &nbsp;&middot;&nbsp; <i class="fa-solid fa-calendar"></i> ' + date : '') +
        (slot ? ' &nbsp;&middot;&nbsp; <i class="fa-solid fa-clock"></i> '    + slot : '') +
      '</div>'
    : '';

  var html = '';
  var isOnline = (type === 'online' || status === 'payment_uploaded' || status === 'online_pending');

  if (status === 'pending' || status === 'payment_uploaded' || status === 'online_pending') {
    html =
      '<div class="ss-icon ' + (isOnline ? 'ss-online' : 'ss-pending') + '">' +
        '<i class="fa-solid ' + (isOnline ? 'fa-video' : 'fa-hourglass-half') + '"></i>' +
      '</div>' +
      '<h2 class="ss-title">' + (isOnline ? 'Consultation Submitted!' : 'Appointment Submitted!') + '</h2>' +
      '<div class="ss-bubble ' + (isOnline ? 'online' : 'pending') + '">' +
        '<div class="ss-status-label ' + (isOnline ? 'online' : 'pending') + '">' + (isOnline ? '📋 PAYMENT UPLOADED' : '⏳ PENDING') + '</div>' +
        '<p class="ss-main-msg">' + (isOnline ? 'Payment screenshot uploaded. Admin will verify shortly.' : 'Your appointment is pending confirmation.') + '</p>' +
        '<p class="ss-wait-msg">Please wait <strong>15–30 minutes</strong> and check back here.</p>' +
      '</div>' + strip +
      '<button class="ss-dismiss-btn ' + (isOnline ? 'online' : '') + '" type="button" onclick="dismissStatus()">' +
        '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard' +
      '</button>';
  } else if (status === 'approved') {
    html =
      '<div class="ss-icon ss-approved"><i class="fa-solid fa-circle-check"></i></div>' +
      '<h2 class="ss-title">Appointment Confirmed!</h2>' +
      '<div class="ss-bubble approved">' +
        '<div class="ss-status-label approved">✅ APPROVED</div>' +
        '<p class="ss-main-msg">Doctor has confirmed your appointment.</p>' +
        (msg ? '<div class="ss-doctor-msg"><i class="fa-solid fa-comment-medical"></i> <em>&ldquo;' + esc(msg) + '&rdquo;</em></div>' : '') +
        (type === 'online' ? '<p class="ss-wait-msg" style="margin-top:10px">Go to <strong>Dashboard</strong> to join your video consultation.</p>' : '') +
      '</div>' + strip +
      '<button class="ss-dismiss-btn approved" type="button" onclick="dismissStatus()">' +
        '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard' +
      '</button>';
  } else if (status === 'rejected') {
    html =
      '<div class="ss-icon ss-rejected"><i class="fa-solid fa-circle-xmark"></i></div>' +
      '<h2 class="ss-title">Appointment Rejected</h2>' +
      '<div class="ss-bubble rejected">' +
        '<div class="ss-status-label rejected">❌ REJECTED</div>' +
        '<p class="ss-main-msg">Doctor has rejected this appointment.</p>' +
        (msg ? '<div class="ss-doctor-msg"><i class="fa-solid fa-comment-medical"></i> <em>&ldquo;' + esc(msg) + '&rdquo;</em></div>' : '') +
      '</div>' + strip +
      '<button class="ss-dismiss-btn rejected" type="button" onclick="dismissStatus()">' +
        '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard' +
      '</button>';
  }

  if (html) {
    $('statusContent').innerHTML = html;
    el.classList.add('open');
  }
}

function dismissStatus() {
  var el = $('statusScreen');
  if (el) el.classList.remove('open');
  goToPage('dashboard');
}

/* ═══════════════════════════════════════════════════════════════
   VIDEO CALL — Jitsi lazy-loaded on demand
   Never loaded on page init — prevents InfinityFree freezes
═══════════════════════════════════════════════════════════════ */
function joinVideoCall(apptId, roomId) {
  if (!roomId) { toast('Video room not ready yet — please wait', 'error'); return; }
  goToPage('video');

  if (jitsiLoaded) {
    _startJitsi(apptId, roomId);
  } else {
    // Lazy-load Jitsi script only when needed
    var container = $('jitsiContainer');
    if (container) container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:300px;color:#fff;gap:12px"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px"></i> Loading video...</div>';

    var script = document.createElement('script');
    script.src = 'https://meet.jit.si/external_api.js';
    script.async = true;
    script.onload = function() {
      jitsiLoaded = true;
      _startJitsi(apptId, roomId);
    };
    script.onerror = function() {
      toast('Video service failed to load — check internet connection', 'error');
      if (container) container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:300px;color:#ef4444;gap:12px"><i class="fa-solid fa-video-slash"></i> Video service unavailable</div>';
    };
    document.body.appendChild(script);
  }
}

function _startJitsi(apptId, roomId) {
  if (jitsiAPI) { try { jitsiAPI.dispose(); } catch(e) {} jitsiAPI = null; }
  var container = $('jitsiContainer');
  if (!container) return;
  container.innerHTML = '';

  try {
    var uname = (currentUser && currentUser.displayName) ? currentUser.displayName : 'Patient';
    jitsiAPI = new JitsiMeetExternalAPI('meet.jit.si', {
      roomName:   'ksp-' + roomId,
      parentNode: container,
      width:      '100%',
      height:     420,
      userInfo:   { displayName: uname },
      configOverwrite: {
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        disableDeepLinking:  true
      },
      interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS: ['microphone','camera','hangup','chat','tileview'],
        SHOW_JITSI_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false
      }
    });
    jitsiAPI.addEventListener('videoConferenceLeft', function() { endCall(); });
  } catch(e) {
    toast('Could not start video call: ' + e.message, 'error');
    console.error('Jitsi error:', e);
  }

  // Listen for prescription on this appointment
  if (db) {
    db.collection('appointments').doc(apptId).onSnapshot(function(d) {
      if (d.exists) {
        var data = d.data();
        var ps = $('prescriptionSection'), pl = $('prescriptionLink');
        if (data.prescriptionURL && ps && pl) {
          ps.style.display = 'block';
          pl.href = data.prescriptionURL;
        }
      }
    }, function(e) { console.warn('Prescription listener:', e); });
  }
}

function toggleMic() {
  if (!jitsiAPI) return;
  try {
    jitsiAPI.executeCommand('toggleAudio');
    var btn = $('micBtn'); if (!btn) return;
    btn.classList.toggle('off');
    var ico = btn.querySelector('i');
    if (ico) ico.className = btn.classList.contains('off') ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone';
  } catch(e) { console.warn('toggleMic:', e); }
}

function toggleCam() {
  if (!jitsiAPI) return;
  try {
    jitsiAPI.executeCommand('toggleVideo');
    var btn = $('camBtn'); if (!btn) return;
    btn.classList.toggle('off');
    var ico = btn.querySelector('i');
    if (ico) ico.className = btn.classList.contains('off') ? 'fa-solid fa-video-slash' : 'fa-solid fa-video';
  } catch(e) { console.warn('toggleCam:', e); }
}

function endCall() {
  if (jitsiAPI) {
    try { jitsiAPI.dispose(); } catch(e) {}
    jitsiAPI = null;
  }
  var c = $('jitsiContainer');
  if (c) c.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:300px;color:#fff;font-weight:600;gap:10px"><i class="fa-solid fa-phone-slash"></i> Call Ended</div>';
  toast('Call ended', 'success');
}

/* ═══════════════════════════════════════════════════════════════
   GLOBAL ERROR SAFETY NET
   Catches any unhandled script errors — app stays usable
═══════════════════════════════════════════════════════════════ */
window.addEventListener('error', function(e) {
  console.error('Global error:', e.message, e.filename, e.lineno);
  hideLoader(); // Always un-stick loader on any crash
  // Don't show toast for every console error — only show for critical ones
});

window.addEventListener('unhandledrejection', function(e) {
  console.error('Unhandled promise rejection:', e.reason);
  hideLoader();
});
