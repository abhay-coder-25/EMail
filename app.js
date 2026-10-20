// --- CONFIGURATION ---
const CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/gmail.modify";
const WIP_BATCH_SIZE = 100;
const SYNC_TARGET_SIZE = 100;
const MAX_SYNC_PAGES = 25; // Circuit breaker: max 2,500 messages scanned per sync
const API_CONCURRENCY = 10;
const REPLAY_DURATION = 1400;

// --- PERSISTENCE HELPER ---
const Storage = {
  get: (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) || fallback; } 
    catch { return fallback; }
  },
  set: (k, val) => {
    try { localStorage.setItem(k, JSON.stringify(val)); } catch (_) {}
  }
};

// --- CORE BUCKET STATE ---
let bucketGeneral = Storage.get("bucket_general", []); // Staged inbox items
let bucketKept    = Storage.get("bucket_kept", []);    // Swiped UP
let bucketReview  = Storage.get("bucket_review", []);  // Swiped DOWN
let bucketDeleted = Storage.get("bucket_deleted", []); // Swiped horizontal (Commit target)

// Active WIP Stack
let bucketWip = Storage.get("bucket_wip", []); // The uncompleted cards in WIP
let currentStackIndex = Storage.get("stack_current_index", 0);

// Tracks decisions made on cards in the current active WIP run: Map<id, 'keep'|'review'|'delete'>
let wipDecisions = Storage.get("wip_decisions", {});

// Replay State
let isReplayMode = false;
let replayStack = [];
let replayRescues = new Map(); // id -> 'keep' | 'review'

// Interaction State
let sweepTimer = null;
let isPointerDown = false;
let startX = 0, startY = 0, currentX = 0, currentY = 0;
let currentCardEl = null;
let accessToken = null;
let tokenClient = null;

// DOM Elements
const authBtn = document.getElementById("auth-btn");
const logoutBtn = document.getElementById("logout-btn");
const syncBtn = document.getElementById("sync-btn");
const startWipBtn = document.getElementById("start-wip-btn");
const stopBtn = document.getElementById("stop-btn");
const commitBtn = document.getElementById("commit-btn");
const countGeneral = document.getElementById("count-general");
const countWip = document.getElementById("count-wip");
const countKept = document.getElementById("count-kept");
const countReview = document.getElementById("count-review");
const countDeleted = document.getElementById("count-deleted");
const deck = document.getElementById("deck");
const footerActions = document.getElementById("footer-actions");
const reviewModal = document.getElementById("review-modal");
const modalTitle = document.getElementById("modal-title");
const reviewSummary = document.getElementById("review-summary");
const queuedEmailsList = document.getElementById("queued-emails-list");
const modalButtons = document.getElementById("modal-buttons");

// Sync bucket counts to UI & storage
function persistBuckets() {
  Storage.set("bucket_general", bucketGeneral);
  Storage.set("bucket_kept", bucketKept);
  Storage.set("bucket_review", bucketReview);
  Storage.set("bucket_deleted", bucketDeleted);
  Storage.set("bucket_wip", bucketWip);
  Storage.set("wip_decisions", wipDecisions);
  Storage.set("stack_current_index", currentStackIndex);

  countGeneral.innerText = `General: ${bucketGeneral.length}`;
  countWip.innerText = `WIP: ${currentStackIndex}/${bucketWip.length}`;
  countKept.innerText = `Kept: ${bucketKept.length}`;
  countReview.innerText = `Review: ${bucketReview.length}`;
  countDeleted.innerText = `Deleted: ${bucketDeleted.length}`;

  if (bucketDeleted.length > 0) {
    commitBtn.classList.remove("hidden");
    commitBtn.innerText = `Commit Trash (${bucketDeleted.length})`;
  } else {
    commitBtn.classList.add("hidden");
  }

  // Show "Start WIP" if WIP is empty and General has cards, or "Resume WIP" if WIP has unreached cards
  if (bucketWip.length > 0 && deck.querySelector(".empty-state")) {
    startWipBtn.classList.remove("hidden");
    startWipBtn.innerText = `⚡ Resume WIP (${bucketWip.length})`;
  } else if (bucketWip.length === 0 && bucketGeneral.length > 0) {
    startWipBtn.classList.remove("hidden");
    startWipBtn.innerText = `⚡ Start WIP (${Math.min(WIP_BATCH_SIZE, bucketGeneral.length)})`;
  } else {
    startWipBtn.classList.add("hidden");
  }
}

// Concurrency helper
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// Audio Feedback
function playTone(freq1, freq2) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(freq1, now);
    if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, now + 0.15);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch (_) {}
}

// Init GIS
window.onload = () => {
  persistBuckets();

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (res) => {
      if (res.error) throw res;
      accessToken = res.access_token;
      authBtn.classList.add("hidden");
      logoutBtn.classList.remove("hidden");
      syncBtn.classList.remove("hidden");

      if (bucketWip.length > 0) {
        stopBtn.classList.remove("hidden");
        footerActions.classList.remove("hidden");
        renderDeck();
      } else if (bucketGeneral.length === 0) {
        await syncToGeneral();
      } else {
        renderIdleDeck();
      }
    },
  });
};

authBtn.onclick = () => tokenClient.requestAccessToken({ prompt: "consent" });
logoutBtn.onclick = () => {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {
      localStorage.clear();
      location.reload();
    });
  }
};

async function gmailFetch(endpoint, options = {}) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// =========================================================================
// 1. INBOX INGESTION WITH CIRCUIT BREAKER (MAX_SYNC_PAGES = 25)
// =========================================================================
syncBtn.onclick = () => syncToGeneral();

async function syncToGeneral() {
  deck.innerHTML = '<div class="empty-state">Harvesting fresh inbox records...</div>';

  const knownIds = new Set([
    ...bucketGeneral.map((m) => m.id),
    ...bucketKept.map((m) => m.id),
    ...bucketReview.map((m) => m.id),
    ...bucketDeleted.map((m) => m.id),
    ...bucketWip.map((m) => m.id),
  ]);

  const candidateIds = [];
  let pageToken = null;
  let pageCount = 0;

  while (candidateIds.length < SYNC_TARGET_SIZE && pageCount < MAX_SYNC_PAGES) {
    pageCount++;
    const queryUrl = `messages?maxResults=100&q=in:inbox${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await gmailFetch(queryUrl);

    if (!data.messages || data.messages.length === 0) break;

    for (const msg of data.messages) {
      if (!knownIds.has(msg.id) && !candidateIds.includes(msg.id)) {
        candidateIds.push(msg.id);
        if (candidateIds.length >= SYNC_TARGET_SIZE) break;
      }
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  if (candidateIds.length === 0) {
    deck.innerHTML = `
      <div class="empty-state">
        <h2>No new messages found</h2>
        <p style="margin-top:0.5rem; color:var(--text-muted);">
          Scanned ${pageCount} pages (${pageCount * 100} messages). All are already in local buckets.
        </p>
      </div>
    `;
    renderIdleDeck();
    return;
  }

  const raw = await mapConcurrent(candidateIds, API_CONCURRENCY, (id) =>
    gmailFetch(`messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)
  );

  const newRecords = raw.map((msg) => {
    const headers = Object.fromEntries(msg.payload.headers.map((h) => [h.name.toLowerCase(), h.value]));
    const parsed = parseSender(headers["from"]);
    return {
      id: msg.id,
      name: parsed.name,
      email: parsed.email,
      subject: headers["subject"] || "(No Subject)",
      snippet: msg.snippet || "(No preview available)",
    };
  });

  bucketGeneral.push(...newRecords);
  persistBuckets();
  renderIdleDeck();
}

function parseSender(fromHeader = "") {
  const match = fromHeader.match(/(.*?)\s*<([^>]+)>/);
  if (match) {
    return {
      name: match[1].replace(/["']/g, "").trim() || match[2].trim(),
      email: match[2].trim(),
    };
  }
  return { name: fromHeader, email: fromHeader };
}

function renderIdleDeck() {
  footerActions.classList.add("hidden");
  stopBtn.classList.add("hidden");

  deck.innerHTML = `
    <div class="empty-state">
      <h2>${bucketGeneral.length} emails in General</h2>
      ${bucketWip.length > 0 ? `<p style="margin-top:0.5rem; color:#fbbf24;">${bucketWip.length} unreached cards currently waiting in WIP.</p>` : ''}
      <p style="margin-top:0.5rem;">Emails in General wait untouched until reserved into WIP.</p>
      ${bucketWip.length > 0 
        ? `<button id="btn-start-wip-idle" class="btn btn-warning" style="margin-top:1.5rem;">⚡ Resume WIP (${bucketWip.length} Cards)</button>`
        : (bucketGeneral.length > 0 ? `<button id="btn-start-wip-idle" class="btn btn-primary" style="margin-top:1.5rem;">⚡ Start WIP Stack (${Math.min(WIP_BATCH_SIZE, bucketGeneral.length)})</button>` : '')
      }
    </div>
  `;
  const btn = document.getElementById("btn-start-wip-idle");
  if (btn) btn.onclick = startWipStack;
}

// =========================================================================
// 2. START / RESUME WIP
// =========================================================================
startWipBtn.onclick = startWipStack;

function startWipStack() {
  // If WIP already has unreached cards, simply resume them
  if (bucketWip.length === 0) {
    if (bucketGeneral.length === 0) return;
    bucketWip = bucketGeneral.slice(0, WIP_BATCH_SIZE);
    currentStackIndex = 0;
    wipDecisions = {};
  }

  isReplayMode = false;
  persistBuckets();
  footerActions.classList.remove("hidden");
  stopBtn.classList.remove("hidden");
  renderDeck();
}

// =========================================================================
// 3. SWEEP ENGINE: UP = KEEP, DOWN = REVIEW, HORIZONTAL = TO DELETE
// =========================================================================
function renderDeck() {
  deck.innerHTML = "";
  clearTimeout(sweepTimer);

  const activeStack = isReplayMode ? replayStack : bucketWip;

  if (currentStackIndex >= activeStack.length) {
    if (isReplayMode) {
      finishReplaySession();
    } else {
      finishWipSession();
    }
    return;
  }

  for (let i = Math.min(currentStackIndex + 1, activeStack.length - 1); i >= currentStackIndex; i--) {
    const data = activeStack[i];
    const isTop = i === currentStackIndex;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = data.id;
    card.style.transform = isTop ? "scale(1)" : "scale(0.96) translateY(10px)";
    card.style.zIndex = isTop ? "2" : "1";

    card.innerHTML = `
      <div class="timer-bar" id="timer-${data.id}"></div>
      <div class="stamp-action stamp-keep">⭐ ${isReplayMode ? "RESCUED" : "KEEP"}</div>
      <div class="stamp-action stamp-review">🔍 REVIEW</div>
      <div class="sender-meta">
        <div class="sender-name">${escapeHtml(data.name)}</div>
        <div class="sender-email-badge">✉ ${escapeHtml(data.email)}</div>
      </div>
      <div class="email-subject">${escapeHtml(data.subject)}</div>
      <div class="email-snippet">${escapeHtml(data.snippet)}</div>
    `;

    if (isTop) {
      currentCardEl = card;
      attachPointerGestures(card);
      if (isReplayMode) startReplayTimer(card);
    }

    deck.appendChild(card);
  }
}

function startReplayTimer(cardEl) {
  clearTimeout(sweepTimer);
  const bar = cardEl.querySelector(".timer-bar");
  if (bar) {
    bar.className = "timer-bar";
    void bar.offsetWidth;
    bar.classList.add("timer-active-replay");
  }
  sweepTimer = setTimeout(() => {
    executeSwipe("left"); // Timed out in replay remains in Deleted
  }, REPLAY_DURATION);
}

function attachPointerGestures(el) {
  const onPointerDown = (e) => {
    isPointerDown = true;
    startX = e.clientX;
    startY = e.clientY;
    currentX = 0;
    currentY = 0;
    el.style.transition = "none";
    clearTimeout(sweepTimer);
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!isPointerDown) return;
    currentX = e.clientX - startX;
    currentY = e.clientY - startY;

    el.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;

    const stampKeep = el.querySelector(".stamp-keep");
    const stampReview = el.querySelector(".stamp-review");

    // UP = Keep (Emerald Aura)
    if (currentY < -40 && Math.abs(currentX) < 90) {
      stampKeep.style.opacity = Math.min(Math.abs(currentY) / 90, 1);
      stampReview.style.opacity = "0";
      el.style.borderColor = "var(--saved-border)";
      el.style.boxShadow = `0 0 ${Math.abs(currentY) / 2.5}px rgba(16, 185, 129, 0.4)`;
    } 
    // DOWN = Review (Indigo Aura)
    else if (currentY > 40 && Math.abs(currentX) < 90) {
      stampReview.style.opacity = Math.min(currentY / 90, 1);
      stampKeep.style.opacity = "0";
      el.style.borderColor = "var(--review-border)";
      el.style.boxShadow = `0 0 ${currentY / 2.5}px rgba(129, 140, 248, 0.4)`;
    } 
    // Horizontal = Clean Pass to Delete (No stamps)
    else {
      stampKeep.style.opacity = "0";
      stampReview.style.opacity = "0";
      el.style.borderColor = "var(--border)";
      el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.5)";
    }
  };

  const onPointerUp = (e) => {
    if (!isPointerDown) return;
    isPointerDown = false;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}

    // UP: Keep
    if (currentY < -80 && Math.abs(currentX) < 100) {
      executeSwipe("up");
    } 
    // DOWN: Review
    else if (currentY > 80 && Math.abs(currentX) < 100) {
      executeSwipe("down");
    } 
    // LEFT: Delete
    else if (currentX < -90) {
      executeSwipe("left");
    } 
    // RIGHT: Delete
    else if (currentX > 90) {
      executeSwipe("right");
    } 
    // Snap back
    else {
      el.style.transition = "transform 0.15s ease-out, border-color 0.15s, box-shadow 0.15s";
      el.style.transform = "scale(1)";
      el.style.borderColor = "var(--border)";
      el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.5)";
      el.querySelector(".stamp-keep").style.opacity = "0";
      el.querySelector(".stamp-review").style.opacity = "0";
      if (isReplayMode) startReplayTimer(el);
    }
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
}

// Action Dispatcher
function executeSwipe(direction) {
  if (!currentCardEl) return;
  clearTimeout(sweepTimer);

  const activeStack = isReplayMode ? replayStack : bucketWip;
  const cardData = activeStack[currentStackIndex];

  if (direction === "up") {
    // ⬆ SWIPE UP = KEEP
    playTone(587.33, 880); // Emerald high chime
    currentCardEl.classList.add("saving-active");
    if (isReplayMode) {
      replayRescues.set(cardData.id, "keep");
    } else {
      wipDecisions[cardData.id] = "keep";
    }
  } else if (direction === "down") {
    // ⬇ SWIPE DOWN = REVIEW
    playTone(440, 554.37); // Indigo mid-tone chime
    currentCardEl.classList.add("review-active");
    if (isReplayMode) {
      replayRescues.set(cardData.id, "review");
    } else {
      wipDecisions[cardData.id] = "review";
    }
  } else {
    // ⬅ / ➡ HORIZONTAL = TO DELETE QUEUE
    currentCardEl.classList.add(direction === "left" ? "flick-left" : "flick-right");
    if (!isReplayMode) {
      wipDecisions[cardData.id] = "delete";
    }
  }

  currentStackIndex++;
  persistBuckets();

  setTimeout(() => {
    renderDeck();
  }, (direction === "up" || direction === "down") ? 220 : 130);
}

// Navigation & Shortcuts
document.getElementById("btn-swipe-left").onclick = () => executeSwipe("left");
document.getElementById("btn-swipe-up").onclick = () => executeSwipe("up");
document.getElementById("btn-swipe-down").onclick = () => executeSwipe("down");
document.getElementById("btn-swipe-right").onclick = () => executeSwipe("right");

window.addEventListener("keydown", (e) => {
  const activeStack = isReplayMode ? replayStack : bucketWip;
  if (reviewModal.classList.contains("hidden") && currentStackIndex < activeStack.length) {
    if (e.key === "ArrowUp") executeSwipe("up");
    if (e.key === "ArrowDown") executeSwipe("down");
    if (e.key === "ArrowLeft") executeSwipe("left");
    if (e.key === "ArrowRight") executeSwipe("right");
  }
});

// =========================================================================
// 4. STOPPING IN BETWEEN:
// Cards gone through finalize. Unreached cards STAY IN WIP.
// =========================================================================
stopBtn.onclick = () => {
  clearTimeout(sweepTimer);
  showEarlyStopModal();
};

function showEarlyStopModal() {
  modalTitle.innerText = "WIP Session Paused";

  const total = bucketWip.length;
  const processedCount = currentStackIndex;
  const unreachedCount = total - processedCount;

  // Tally processed cards
  const processedCards = bucketWip.slice(0, processedCount);
  let keptCount = 0, reviewCount = 0, deleteCount = 0;

  processedCards.forEach((c) => {
    const dec = wipDecisions[c.id];
    if (dec === "keep") keptCount++;
    else if (dec === "review") reviewCount++;
    else deleteCount++;
  });

  reviewSummary.innerHTML = `
    Processed <strong>${processedCount}</strong> cards:<br/>
    • <strong>${keptCount}</strong> to Kept (swiped Up).<br/>
    • <strong>${reviewCount}</strong> to Review (swiped Down).<br/>
    • <strong>${deleteCount}</strong> to Deleted (flicked horizontally).<br/><br/>
    <strong>${unreachedCount}</strong> unreached cards will <strong>stay in WIP</strong> for when you return.
  `;

  renderQueuedEmailsList(bucketDeleted);

  modalButtons.innerHTML = `
    <button id="btn-confirm-stop" class="btn btn-warning">
      Commit ${processedCount} Processed (Leave ${unreachedCount} in WIP)
    </button>
    <button id="btn-resume" class="btn btn-ghost">Continue Sweeping</button>
  `;

  document.getElementById("btn-confirm-stop").onclick = () => {
    // 1. Move processed cards to their target buckets
    const processedIds = new Set(processedCards.map((c) => c.id));

    processedCards.forEach((card) => {
      const dec = wipDecisions[card.id];
      if (dec === "keep") bucketKept.push(card);
      else if (dec === "review") bucketReview.push(card);
      else bucketDeleted.push(card);
    });

    // 2. Remove processed cards from General
    bucketGeneral = bucketGeneral.filter((c) => !processedIds.has(c.id));

    // 3. UNREACHED CARDS STAY IN WIP
    bucketWip = bucketWip.slice(currentStackIndex);
    currentStackIndex = 0;
    wipDecisions = {};

    persistBuckets();
    reviewModal.classList.add("hidden");
    renderIdleDeck();
  };

  document.getElementById("btn-resume").onclick = () => {
    reviewModal.classList.add("hidden");
    if (isReplayMode && currentCardEl) startReplayTimer(currentCardEl);
  };

  reviewModal.classList.remove("hidden");
}

// =========================================================================
// 5. FINISHING WIP STACK (All cards gone through)
// =========================================================================
function finishWipSession() {
  modalTitle.innerText = "WIP Stack Complete";

  const wipIds = new Set(bucketWip.map((c) => c.id));

  // Partition all cards based on their recorded decisions
  bucketWip.forEach((card) => {
    const dec = wipDecisions[card.id];
    if (dec === "keep") bucketKept.push(card);
    else if (dec === "review") bucketReview.push(card);
    else bucketDeleted.push(card);
  });

  // Remove all completed cards from General
  bucketGeneral = bucketGeneral.filter((c) => !wipIds.has(c.id));

  // WIP is now empty
  bucketWip = [];
  currentStackIndex = 0;
  wipDecisions = {};
  persistBuckets();

  reviewSummary.innerHTML = `
    All cards processed:<br/>
    • <strong>${bucketKept.length}</strong> in Kept.<br/>
    • <strong>${bucketReview.length}</strong> in Review.<br/>
    • <strong>${bucketDeleted.length}</strong> in Deleted (Queued for Commit).<br/>
    • <strong>${bucketGeneral.length}</strong> remaining in General.
  `;

  renderQueuedEmailsList(bucketDeleted);

  modalButtons.innerHTML = `
    ${bucketDeleted.length > 0 ? '<button id="btn-commit-now" class="btn btn-danger">Commit Deleted to Trash Now</button>' : ''}
    ${bucketDeleted.length > 0 ? '<button id="btn-run-replay" class="btn btn-secondary">⚡ Run Replay Safety Net</button>' : ''}
    ${bucketGeneral.length > 0 ? '<button id="btn-clean-next" class="btn btn-primary">Start Next 100 from General</button>' : ''}
    <button id="btn-done" class="btn btn-ghost">Back to Overview</button>
  `;

  const commitBtnModal = document.getElementById("btn-commit-now");
  if (commitBtnModal) commitBtnModal.onclick = () => commitBucketDeleted();

  const replayBtn = document.getElementById("btn-run-replay");
  if (replayBtn) {
    replayBtn.onclick = () => {
      reviewModal.classList.add("hidden");
      replayStack = [...bucketDeleted];
      replayRescues.clear();
      currentStackIndex = 0;
      isReplayMode = true;
      footerActions.classList.remove("hidden");
      renderDeck();
    };
  }

  const nextBtn = document.getElementById("btn-clean-next");
  if (nextBtn) {
    nextBtn.onclick = () => {
      reviewModal.classList.add("hidden");
      startWipStack();
    };
  }

  document.getElementById("btn-done").onclick = () => {
    reviewModal.classList.add("hidden");
    renderIdleDeck();
  };

  reviewModal.classList.remove("hidden");
}

function finishReplaySession() {
  modalTitle.innerText = "Replay Complete";
  isReplayMode = false;

  // Resolve rescued items from replay
  replayStack.forEach((card) => {
    if (replayRescues.has(card.id)) {
      const type = replayRescues.get(card.id);
      if (type === "keep") bucketKept.push(card);
      else if (type === "review") bucketReview.push(card);
      bucketDeleted = bucketDeleted.filter((c) => c.id !== card.id);
    }
  });

  replayStack = [];
  replayRescues.clear();
  currentStackIndex = 0;
  persistBuckets();

  reviewSummary.innerHTML = `
    Replay Finished:<br/>
    • <strong>${bucketDeleted.length}</strong> confirmed in Deleted (Queued for Commit).<br/>
    • <strong>${bucketKept.length}</strong> in Kept.<br/>
    • <strong>${bucketReview.length}</strong> in Review.
  `;

  renderQueuedEmailsList(bucketDeleted);

  modalButtons.innerHTML = `
    ${bucketDeleted.length > 0 ? '<button id="btn-replay-commit" class="btn btn-danger">Commit Remaining Deleted to Trash</button>' : ''}
    <button id="btn-replay-done" class="btn btn-ghost">Back to Overview</button>
  `;

  const commitBtnModal = document.getElementById("btn-replay-commit");
  if (commitBtnModal) commitBtnModal.onclick = () => commitBucketDeleted();

  document.getElementById("btn-replay-done").onclick = () => {
    reviewModal.classList.add("hidden");
    renderIdleDeck();
  };

  reviewModal.classList.remove("hidden");
}

function renderQueuedEmailsList(list) {
  queuedEmailsList.innerHTML = "";
  if (list.length === 0) {
    queuedEmailsList.innerHTML = '<div style="color:var(--text-muted); padding:0.5rem;">Deleted bucket is empty.</div>';
    return;
  }
  list.forEach((item) => {
    const row = document.createElement("div");
    row.className = "queued-email-item";
    row.innerText = `✉ ${item.email} — "${item.subject}"`;
    queuedEmailsList.appendChild(row);
  });
}

// =========================================================================
// 6. COMMIT BOUNDARY: DURABLE TRASHING OF DELETED BUCKET ONLY
// =========================================================================
commitBtn.onclick = () => commitBucketDeleted();

async function commitBucketDeleted() {
  reviewModal.classList.add("hidden");

  if (!navigator.onLine) {
    alert("You are offline. Deleted items remain safely stored. Commit when online.");
    return;
  }

  if (bucketDeleted.length === 0) {
    alert("Nothing in Deleted bucket.");
    return;
  }

  const itemsToTrash = [...bucketDeleted];
  deck.innerHTML = `<div class="empty-state">Moving ${itemsToTrash.length} items from Deleted to Gmail Trash...</div>`;

  let successCount = 0;
  let failureCount = 0;

  // Durable queue execution
  await mapConcurrent(itemsToTrash, API_CONCURRENCY, async (item) => {
    try {
      await gmailFetch(`messages/${item.id}/trash`, { method: "POST" });
      successCount++;
      bucketDeleted = bucketDeleted.filter((m) => m.id !== item.id);
      persistBuckets();
    } catch (err) {
      console.error(`Failed to trash message ${item.id}:`, err);
      failureCount++;
    }
  });

  const failureNotice = failureCount > 0 
    ? `<p style="color:var(--trash); margin-top:0.5rem;">${failureCount} items failed to trash and remain in Deleted for retry.</p>` 
    : "";

  deck.innerHTML = `
    <div class="empty-state">
      <h2>Commit Complete 🗑</h2>
      <p>${successCount} emails successfully moved to Gmail Trash.</p>
      ${failureNotice}
      <p style="margin-top:0.5rem; color:var(--text-muted);">
        General (${bucketGeneral.length}), WIP (${bucketWip.length}), Kept (${bucketKept.length}), and Review (${bucketReview.length}) remain untouched in Gmail.
      </p>
      ${bucketWip.length > 0 
        ? `<button id="btn-next-wip-done" class="btn btn-warning" style="margin-top:1.5rem;">Resume WIP (${bucketWip.length} Remaining)</button>`
        : (bucketGeneral.length > 0 ? `<button id="btn-next-wip-done" class="btn btn-primary" style="margin-top:1.5rem;">Start Next WIP (${Math.min(WIP_BATCH_SIZE, bucketGeneral.length)})</button>` : '')
      }
    </div>
  `;
  const btn = document.getElementById("btn-next-wip-done");
  if (btn) btn.onclick = startWipStack;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.innerText = str;
  return d.innerHTML;
}
