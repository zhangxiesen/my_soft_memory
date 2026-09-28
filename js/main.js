/* ========== 拾光记 · 云端版 main.js ==========
   登录（邮箱）+ 云数据库（按用户隔离）+ 云存储（照片/视频）+ 公开分享 */
(function () {
  "use strict";

  /* ---------- 云客户端（publicConfig） ---------- */
  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: "https://shiguang-diary-31904.app.workbuddy.host",
    publishableKey: "wbpk_MtBqNLGH1tDoIgrTKqyf0N_o79UH95hV8fCaOnjhJelguKlr91e3MbA",
  });

  /* ---------- 工具 ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const objectURLs = [];
  const objectURL = (blob) => { const u = URL.createObjectURL(blob); objectURLs.push(u); return u; };
  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function fmtDate(d) {
    const [y, m, day] = String(d).slice(0, 10).split("-");
    return `${y} 年 ${Number(m)} 月 ${Number(day)} 日`;
  }
  function shareIdGen() {
    return Array.from(crypto.getRandomValues(new Uint8Array(9))).map((b) => b.toString(36)).join("").replace(/[^a-z0-9]/gi, "x").slice(0, 12) + Date.now().toString(36).slice(-4);
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("is-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-show"), 2800);
  }

  const MOODS = { sunny: "晴朗", warm: "温柔", rainy: "落雨", starry: "星夜" };
  const MOOD_ICONS = {
    sunny: '<svg viewBox="0 0 24 24" class="icon"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    warm: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 20s-7-4.4-9.2-8.6C1.2 8.4 3 5 6.4 5c2 0 3.4 1.1 4.2 2.3h2.8C14.2 6.1 15.6 5 17.6 5c3.4 0 5.2 3.4 3.6 6.4C19 15.6 12 20 12 20Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>',
    rainy: '<svg viewBox="0 0 24 24" class="icon"><path d="M7 15a5 5 0 1 1 .8-9.9A6 6 0 0 1 19.5 8 4 4 0 0 1 18 15H7Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><path d="M8 18l-.8 2M12.5 18l-.8 2M17 18l-.8 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    starry: '<svg viewBox="0 0 24 24" class="icon"><path d="M19 13.5A7.5 7.5 0 0 1 10.5 5 7.5 7.5 0 1 0 19 13.5Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><path d="M17 3l.6 1.7L19.3 5.3l-1.7.6L17 7.6l-.6-1.7-1.7-.6 1.7-.6Z" fill="currentColor"/></svg>',
  };

  /* ---------- 全局状态 ---------- */
  let session = null;
  let entries = [];            // [{...row, media:[row]}]
  let squareEntries = [];      // 广场：所有人的公开日记
  let myProfile = null;        // 我的资料
  let moodFilter = "all";
  const urlCache = new Map();  // storage_path -> url

  /* ---------- 错误提示 ---------- */
  function friendlyError(err, fallback) {
    const kind = err && (err.kind || err.code);
    if (kind === "unauthenticated" || kind === "invalid_grant") return "登录状态已失效，请重新登录";
    if (kind === "network" || kind === "backend-unavailable") return "网络不太稳定，请稍后重试";
    if (kind === "42501") return "没有权限执行这个操作";
    return (err && err.message) || fallback || "操作失败，请重试";
  }

  /* ---------- 会话 ---------- */
  async function getSessionSafe() {
    try {
      const { data, error } = await cloud.auth.getSession();
      if (error || !data) return null;
      return data;
    } catch { return null; }
  }

  /* ---------- 数据加载 ---------- */
  async function loadEntries() {
    const [{ data: eRows, error: eErr }, { data: mRows, error: mErr }] = await Promise.all([
      cloud.database.from("diary_entries").select("*").order("entry_date", { ascending: false }).order("created_at", { ascending: false }),
      cloud.database.from("diary_media").select("*"),
    ]);
    if (eErr) throw eErr;
    if (mErr) throw mErr;
    const byEntry = new Map();
    (mRows || []).forEach((m) => {
      if (!byEntry.has(m.entry_id)) byEntry.set(m.entry_id, []);
      byEntry.get(m.entry_id).push(m);
    });
    entries = (eRows || []).map((e) => ({ ...e, media: byEntry.get(e.id) || [] }));
  }

  /* ---------- 媒体 URL（签名 → 下载兜底） ---------- */
  async function signOne(path) {
    if (urlCache.has(path)) return urlCache.get(path);
    let url = "";
    try {
      const { data, error } = await cloud.storage.createSignedUrl(path, 3600);
      if (!error && data) url = typeof data === "string" ? data : (data.signedUrl || data.url || data.signed_url || "");
    } catch { /* 继续兜底 */ }
    if (!url) {
      const blob = await cloud.storage.download(path);
      url = objectURL(blob);
    }
    urlCache.set(path, url);
    return url;
  }
  async function warmUrls(mediaList, pickPath) {
    await Promise.all(mediaList.map(async (m) => {
      const p = pickPath(m);
      if (!p) return;
      try { await signOne(p); } catch { m._broken = true; }
    }));
  }

  /* ---------- 渲染：视图切换 ---------- */
  function renderAuthState() {
    const authed = !!session;
    $$("[data-auth-only]").forEach((el) => { el.hidden = !authed; });
    $$("[data-guest-only]").forEach((el) => { el.hidden = authed; });
    $("#authWall").hidden = authed;
    if (authed) renderNavMe();
  }

  function renderNavMe() {
    if (!session) return;
    const name = myProfile?.nickname || (session.user.email || "").split("@")[0] || "我";
    $("#navName").textContent = name;
    const av = $("#navAvatar");
    const ap = myProfile?.avatar_path;
    if (ap && urlCache.get(ap)) av.innerHTML = `<img src="${esc(urlCache.get(ap))}" alt="">`;
    else { av.innerHTML = ""; av.textContent = name.slice(0, 1); }
  }

  function renderStats() {
    const photos = entries.reduce((n, e) => n + e.media.filter((m) => m.media_type === "image").length, 0);
    const videos = entries.reduce((n, e) => n + e.media.filter((m) => m.media_type === "video").length, 0);
    $("#statEntries").textContent = entries.length;
    $("#statPhotos").textContent = photos;
    $("#statVideos").textContent = videos;
    $("#statDays").textContent = new Set(entries.map((e) => e.entry_date)).size;
  }

  function renderTimeline() {
    const wrap = $("#timelineList");
    const list = entries.filter((e) => moodFilter === "all" || e.mood === moodFilter);
    $("#timelineEmpty").hidden = list.length > 0;
    wrap.innerHTML = list.map((e) => {
      const first = e.media[0];
      let mediaHTML = "";
      if (first && !first._broken) {
        const src = urlCache.get(first.storage_path) || "";
        const isVideo = first.media_type === "video";
        mediaHTML = `
        <figure class="polaroid ${isVideo ? "polaroid--video" : ""}" data-lightbox="${first.id}">
          ${isVideo
            ? `<video src="${esc(src)}" muted playsinline preload="metadata"></video><span class="polaroid__play"><svg viewBox="0 0 24 24" class="icon"><path d="M8 5v14l11-7Z" fill="currentColor"/></svg></span>`
            : `<img src="${esc(src)}" alt="${esc(first.caption || e.title)}" loading="lazy">`}
          <figcaption>${esc(first.caption || e.title)}</figcaption>
          ${e.media.length > 1 ? `<span class="polaroid__count">共 ${e.media.length} 件</span>` : ""}
        </figure>`;
      }
      return `
      <article class="entry" data-id="${e.id}">
        <div class="entry__date">
          <time>${fmtDate(e.entry_date)}</time>
          <span class="entry__mood">${MOOD_ICONS[e.mood] || ""}${MOODS[e.mood] || "温柔"}</span>
          ${e.is_public ? '<span class="entry__mood" style="color:#788c5d;border-color:rgba(120,140,93,.4)">已公开</span>' : ""}
        </div>
        <div class="entry__card">
          ${mediaHTML}
          <div class="entry__body">
            <h3>${esc(e.title)}</h3>
            <p>${esc(e.content)}</p>
            <button class="entry__more" data-read="${e.id}">读这一天的全文 →</button>
          </div>
        </div>
      </article>`;
    }).join("");
    observeReveals(wrap.querySelectorAll(".entry"));
  }

  function renderGallery() {
    const wrap = $("#masonry");
    const items = [];
    entries.forEach((e) => e.media.forEach((m) => { if (!m._broken) items.push({ m, e }); }));
    $("#galleryEmpty").hidden = items.length > 0;
    wrap.innerHTML = items.map(({ m, e }, i) => {
      const src = urlCache.get(m.storage_path) || "";
      const tilt = ((i * 37) % 5 - 2) * 0.9;
      return `
      <figure class="masonry__item" style="--tilt:${tilt}deg" data-lightbox="${m.id}">
        ${m.media_type === "video"
          ? `<video src="${esc(src)}" muted playsinline preload="metadata"></video><span class="masonry__badge"><svg viewBox="0 0 24 24" class="icon"><path d="M8 5v14l11-7Z" fill="currentColor"/></svg></span>`
          : `<img src="${esc(src)}" alt="${esc(m.caption || e.title)}" loading="lazy">`}
        <figcaption>${esc(m.caption || e.title)} · ${fmtDate(e.entry_date)}</figcaption>
      </figure>`;
    }).join("");
    observeReveals(wrap.querySelectorAll(".masonry__item"));
  }

  function renderAll() {
    renderStats();
    renderTimeline();
    renderGallery();
  }

  async function loadAndRender() {
    try {
      await loadEntries();
      const all = [];
      entries.forEach((e) => e.media.forEach((m) => all.push(m)));
      await warmUrls(all, (m) => m.storage_path);
      renderAll();
    } catch (err) {
      console.error(err);
      toast(friendlyError(err, "日记加载失败"));
    }
  }

  /* ---------- 入场观察 ---------- */
  const io = new IntersectionObserver((obs) => {
    obs.forEach((o) => { if (o.isIntersecting) { o.target.classList.add("is-in"); io.unobserve(o.target); } });
  }, { threshold: 0.12 });
  function observeReveals(nodes) { nodes.forEach((n) => io.observe(n)); }

  /* ---------- 弹窗 ---------- */
  function openModal(el) { el.hidden = false; document.body.style.overflow = "hidden"; }
  function closeModal(el) {
    el.hidden = true;
    if (["#composer", "#reader", "#lightbox", "#authModal", "#profileModal", "#publicReader"].every((s) => $(s).hidden)) {
      document.body.style.overflow = "";
    }
  }
  document.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) closeModal(closer.closest(".modal, .lightbox"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ["#composer", "#reader", "#lightbox", "#authModal", "#profileModal", "#publicReader"].forEach((s) => closeModal($(s)));
    if (!$("#lightbox").hidden) {
      if (e.key === "ArrowLeft") stepLightbox(-1);
      if (e.key === "ArrowRight") stepLightbox(1);
    }
  });

  /* ================= 登录 / 注册 ================= */
  function openAuth() {
    $("#formError") && ($("#formError").hidden = true);
    openModal($("#authModal"));
  }
  function closeAuth() { closeModal($("#authModal")); }
  $("#loginBtn").addEventListener("click", openAuth);
  $("#wallLogin").addEventListener("click", openAuth);

  function paneError(form, msg) {
    const el = form.querySelector("[data-err]");
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  function switchAuthTab(tab) {
    $$("#authTabs .authtab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
    $$("#authModal .authform").forEach((f) => { f.hidden = f.dataset.pane !== tab; paneError(f, ""); });
    $("#authTitle").textContent = { password: "欢迎回来", otp: "验证码登录", signup: "加入拾光记", forgot: "找回密码" }[tab] || "欢迎回来";
  }
  $("#authTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".authtab");
    if (btn) switchAuthTab(btn.dataset.tab);
  });
  $("#gotoForgot").addEventListener("click", () => switchAuthTab("forgot"));
  $("#backToLogin").addEventListener("click", () => switchAuthTab("password"));

  /* 验证码发送按钮（60s 倒计时） */
  function countdown(btn) {
    let n = 60;
    btn.disabled = true;
    const tick = () => {
      btn.textContent = `${n}s 后重发`;
      if (n-- <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = "获取验证码"; }
    };
    const timer = setInterval(tick, 1000);
    tick();
  }

  let otpPending = null;    // 验证码登录 challenge
  let signupPending = null; // 注册 challenge
  let forgotStarted = null; // 找回密码 challenge

  $("#aoSend").addEventListener("click", async () => {
    const email = $("#aoEmail").value.trim();
    if (!email) return paneError($("#formOtp"), "先输入邮箱");
    const btn = $("#aoSend");
    btn.disabled = true;
    const { data, error } = await cloud.auth.sendOtp({ email });
    if (error) { btn.disabled = false; return paneError($("#formOtp"), friendlyError(error, "验证码发送失败")); }
    otpPending = { email, verificationId: data.verificationId, isExistingUser: data.isExistingUser };
    countdown(btn);
    paneError($("#formOtp"), "");
    toast("验证码已发送到邮箱");
  });

  $("#formOtp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#aoEmail").value.trim();
    const code = $("#aoCode").value.trim();
    if (!otpPending || otpPending.email !== email) return paneError($("#formOtp"), "请先获取当前邮箱的验证码");
    const { data, error } = await cloud.auth.verifyOtp({
      email, verificationId: otpPending.verificationId,
      isExistingUser: otpPending.isExistingUser, token: code,
    });
    if (error) return paneError($("#formOtp"), friendlyError(error, "验证码不正确"));
    otpPending = null;
    closeAuth();
    toast("欢迎回来");
  });

  $("#asSend").addEventListener("click", async () => {
    const email = $("#asEmail").value.trim();
    if (!email) return paneError($("#formSignup"), "先输入邮箱");
    const btn = $("#asSend");
    btn.disabled = true;
    const { data, error } = await cloud.auth.sendOtp({ email });
    if (error) { btn.disabled = false; return paneError($("#formSignup"), friendlyError(error, "验证码发送失败")); }
    signupPending = { email, verificationId: data.verificationId, isExistingUser: data.isExistingUser };
    countdown(btn);
    toast("验证码已发送到邮箱");
  });

  $("#formSignup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#asEmail").value.trim();
    const password = $("#asPass").value;
    const code = $("#asCode").value.trim();
    if (!signupPending || signupPending.email !== email) return paneError($("#formSignup"), "请先获取当前邮箱的验证码");
    const { error } = await cloud.auth.verifyOtp({
      email, verificationId: signupPending.verificationId,
      isExistingUser: signupPending.isExistingUser, token: code,
      password: signupPending.isExistingUser ? undefined : password,
    });
    if (error) return paneError($("#formSignup"), friendlyError(error, "注册失败"));
    signupPending = null;
    closeAuth();
    toast("注册成功，开始记录吧");
  });

  $("#formPassword").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await cloud.auth.signInWithPassword({
      email: $("#apEmail").value.trim(),
      password: $("#apPass").value,
    });
    if (error) return paneError($("#formPassword"), friendlyError(error, "账号或密码不正确"));
    closeAuth();
    toast("欢迎回来");
  });

  $("#afSend").addEventListener("click", async () => {
    const email = $("#afEmail").value.trim();
    if (!email) return paneError($("#formForgot"), "先输入邮箱");
    const btn = $("#afSend");
    btn.disabled = true;
    const started = await cloud.auth.resetPasswordForEmail(email);
    if (started.error) { btn.disabled = false; return paneError($("#formForgot"), friendlyError(started.error, "发送失败")); }
    forgotStarted = started.data;
    countdown(btn);
    toast("验证码已发送到邮箱");
  });

  $("#formForgot").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!forgotStarted) return paneError($("#formForgot"), "请先获取验证码");
    const { error } = await forgotStarted.updateUser({
      nonce: $("#afCode").value.trim(),
      password: $("#afPass").value,
    });
    if (error) return paneError($("#formForgot"), friendlyError(error, "重置失败"));
    forgotStarted = null;
    closeAuth();
    toast("密码已重置，已为你登录");
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await cloud.auth.signOut();
    toast("已退出登录");
  });

  cloud.auth.onAuthStateChange(async (event, s) => {
    session = s || null;
    renderAuthState();
    if (session) {
      urlCache.clear();
      await Promise.all([loadAndRender(), loadProfile(), loadSquare()]);
    }
    if (event === "SIGNED_OUT") {
      entries = [];
      squareEntries = [];
      myProfile = null;
      urlCache.clear();
      renderAll();
      renderSquare();
    }
  });

  /* ================= 个人主页 ================= */
  let pendingAvatarFile = null;

  async function loadProfile() {
    try {
      const { data, error } = await cloud.database.from("profiles").select("*").eq("owner_id", session.user.id).maybeSingle();
      if (error) throw error;
      myProfile = data || null;
      if (myProfile?.avatar_path) { try { await signOne(myProfile.avatar_path); } catch { /* 头像加载失败则用首字 */ } }
      renderNavMe();
    } catch (err) { console.error(err); }
  }

  function openProfile() {
    if (!session) return openAuth();
    $("#pNickname").value = myProfile?.nickname || "";
    $("#pBio").value = myProfile?.bio || "";
    pendingAvatarFile = null;
    const prev = $("#profileAvatarPreview");
    const ap = myProfile?.avatar_path;
    const name = myProfile?.nickname || (session.user.email || "").split("@")[0] || "我";
    if (ap && urlCache.get(ap)) prev.innerHTML = `<img src="${esc(urlCache.get(ap))}" alt="">`;
    else { prev.innerHTML = ""; prev.textContent = name.slice(0, 1); }
    $("#profileStats").innerHTML = `<span><strong>${entries.length}</strong>篇日记</span><span><strong>${entries.filter((e) => e.is_public).length}</strong>篇公开</span>`;
    paneError($("#profileForm"), "");
    openModal($("#profileModal"));
  }
  $("#profileBtn").addEventListener("click", openProfile);

  $("#avatarInput").addEventListener("change", () => {
    const f = $("#avatarInput").files[0];
    $("#avatarInput").value = "";
    if (!f || !/^image\//.test(f.type)) return;
    if (f.size > 10 * 1024 * 1024) return paneError($("#profileForm"), "头像图片不能超过 10MB");
    pendingAvatarFile = f;
    $("#profileAvatarPreview").innerHTML = `<img src="${objectURL(f)}" alt="">`;
    paneError($("#profileForm"), "");
  });

  $("#profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!session) { closeModal($("#profileModal")); return openAuth(); }
    const btn = $("#profileSave");
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      let avatar_path = myProfile?.avatar_path || null;
      if (pendingAvatarFile) {
        avatar_path = cloud.storage.sharedPath(session.user.id, "profile/avatar");
        const up = await cloud.storage.upload(avatar_path, pendingAvatarFile, { contentType: pendingAvatarFile.type, upsert: true });
        if (up.error) throw up.error;
        urlCache.delete(avatar_path);
        try { await signOne(avatar_path); } catch { /* 下次再取 */ }
        pendingAvatarFile = null;
      }
      const { data, error } = await cloud.database.from("profiles").upsert({
        nickname: $("#pNickname").value.trim(),
        bio: $("#pBio").value.trim(),
        avatar_path,
        updated_at: new Date().toISOString(),
      }).select();
      if (error) throw error;
      myProfile = (data && data[0]) || myProfile;
      renderNavMe();
      closeModal($("#profileModal"));
      toast("主页已更新");
      loadSquare();
    } catch (err) {
      console.error(err);
      paneError($("#profileForm"), friendlyError(err, "保存失败，请重试"));
    } finally {
      btn.disabled = false;
      btn.textContent = "保存";
    }
  });

  /* ================= 广场 ================= */
  async function loadSquare() {
    try {
      const { data: rows, error } = await cloud.database.from("diary_entries")
        .select("*").eq("is_public", true)
        .order("created_at", { ascending: false }).limit(60);
      if (error) throw error;
      squareEntries = rows || [];

      const ownerIds = [...new Set(squareEntries.map((x) => x.owner_id))];
      const profileMap = new Map();
      if (ownerIds.length) {
        const { data: profs } = await cloud.database.from("profiles").select("*").in("owner_id", ownerIds);
        (profs || []).forEach((p) => profileMap.set(p.owner_id, p));
      }

      const entryIds = squareEntries.map((x) => x.id);
      const mediaMap = new Map();
      if (entryIds.length) {
        const { data: mRows } = await cloud.database.from("diary_media").select("*").in("entry_id", entryIds);
        (mRows || []).forEach((m) => {
          if (!mediaMap.has(m.entry_id)) mediaMap.set(m.entry_id, []);
          mediaMap.get(m.entry_id).push(m);
        });
      }

      const toSign = [];
      squareEntries.forEach((x) => {
        x.media = mediaMap.get(x.id) || [];
        x._author = profileMap.get(x.owner_id) || null;
        const first = x.media[0];
        if (first) toSign.push(first.shared_path || (session && x.owner_id === session.user.id ? first.storage_path : null));
        if (x._author?.avatar_path) toSign.push(x._author.avatar_path);
      });
      await Promise.all(toSign.filter(Boolean).map((p) => signOne(p).catch(() => {})));
      renderSquare();
    } catch (err) {
      console.error(err);
    }
  }

  function renderSquare() {
    const wrap = $("#squareList");
    $("#squareEmpty").hidden = squareEntries.length > 0;
    wrap.innerHTML = squareEntries.map((x) => {
      const author = x._author;
      const nick = author?.nickname || "拾光旅人";
      const avUrl = author?.avatar_path ? urlCache.get(author.avatar_path) : null;
      const first = x.media[0];
      const cover = first ? urlCache.get(first.shared_path || first.storage_path) : null;
      const isVideo = first && first.media_type === "video";
      const mine = session && x.owner_id === session.user.id;
      return `
      <article class="scard" data-sread="${x.id}">
        <div class="scard__author">
          <span class="scard__avatar">${avUrl ? `<img src="${esc(avUrl)}" alt="">` : esc(nick.slice(0, 1))}</span>
          <div class="scard__who">
            <div class="scard__nick">${esc(nick)}${mine ? ' <small style="color:var(--ink-faint);font-weight:400">（我）</small>' : ""}</div>
            <div class="scard__meta"><time>${fmtDate(x.entry_date)}</time><span>${MOODS[x.mood] || "温柔"}</span></div>
          </div>
        </div>
        <div class="scard__body">
          <div>
            <h3 class="scard__title">${esc(x.title)}</h3>
            <p class="scard__excerpt">${esc(x.content)}</p>
          </div>
          ${cover ? (isVideo
            ? `<span class="scard__play"><video class="scard__thumb" src="${esc(cover)}" muted playsinline preload="metadata"></video></span>`
            : `<img class="scard__thumb" src="${esc(cover)}" alt="" loading="lazy">`) : ""}
        </div>
      </article>`;
    }).join("");
    observeReveals(wrap.querySelectorAll(".scard"));
  }

  function openPublicReader(id) {
    const x = squareEntries.find((v) => v.id === id);
    if (!x) return;
    const author = x._author;
    const nick = author?.nickname || "拾光旅人";
    const avUrl = author?.avatar_path ? urlCache.get(author.avatar_path) : null;
    $("#publicReaderBody").innerHTML = `
      <div class="authorbar">
        <span class="scard__avatar">${avUrl ? `<img src="${esc(avUrl)}" alt="">` : esc(nick.slice(0, 1))}</span>
        <div style="min-width:0">
          <div class="scard__nick">${esc(nick)}</div>
          ${author?.bio ? `<div class="authorbar__bio">${esc(author.bio)}</div>` : ""}
        </div>
      </div>
      <div class="reader__date">
        <time>${fmtDate(x.entry_date)}</time>
        <span class="entry__mood">${MOOD_ICONS[x.mood] || ""}${MOODS[x.mood] || "温柔"}</span>
      </div>
      <h3 class="reader__title">${esc(x.title)}</h3>
      ${x.media.length ? `<div class="reader__media">${x.media.map((m) => {
        const src = urlCache.get(m.shared_path || m.storage_path) || "";
        if (!src) return "";
        return m.media_type === "video"
          ? `<video src="${esc(src)}" controls playsinline preload="metadata"></video>`
          : `<img src="${esc(src)}" alt="${esc(m.caption || "")}">`;
      }).join("")}</div>` : ""}
      <div class="reader__content">${esc(x.content)}</div>`;
    openModal($("#publicReader"));
  }

  /* ================= 写日记 ================= */
  let pendingFiles = [];
  let composerMood = "sunny";

  function openComposer() {
    if (!session) return openAuth();
    $("#entryForm").reset();
    $("#fDate").value = localToday();
    pendingFiles = [];
    renderPreviews();
    setMood("sunny");
    $("#formError").hidden = true;
    openModal($("#composer"));
    setTimeout(() => $("#fTitle").focus(), 60);
  }
  $("#openComposer").addEventListener("click", openComposer);
  $("#heroWrite").addEventListener("click", () => { session ? openComposer() : openAuth(); });
  $("#heroTimeline").addEventListener("click", (e) => {
    if (!session) { e.preventDefault(); openAuth(); }
  });

  function setMood(m) {
    composerMood = m;
    $$("#moodPicker .mood").forEach((b) => b.classList.toggle("is-active", b.dataset.mood === m));
  }
  $("#moodPicker").addEventListener("click", (e) => {
    const btn = e.target.closest(".mood");
    if (btn) setMood(btn.dataset.mood);
  });

  const dz = $("#dropzone");
  const fileInput = $("#fMedia");
  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  ["dragover", "dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.toggle("is-drag", ev === "dragover");
      if (ev === "drop") addFiles(e.dataTransfer.files);
    })
  );
  function addFiles(fileList) {
    const MAX = 80 * 1024 * 1024;
    for (const f of fileList) {
      if (!/^image\//.test(f.type) && !/^video\//.test(f.type)) continue;
      if (f.size > MAX) { showError(`「${f.name}」超过 80MB，存不下啦`); continue; }
      pendingFiles.push(f);
    }
    renderPreviews();
  }
  function renderPreviews() {
    $("#previews").innerHTML = pendingFiles.map((f, i) => {
      const url = objectURL(f);
      const isVideo = /^video\//.test(f.type);
      return `<div class="previews__thumb">
        ${isVideo ? `<video src="${url}" muted></video>` : `<img src="${url}" alt="">`}
        <button type="button" data-rm="${i}" aria-label="移除">×</button>
      </div>`;
    }).join("");
  }
  $("#previews").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rm]");
    if (btn) { pendingFiles.splice(Number(btn.dataset.rm), 1); renderPreviews(); }
  });

  function showError(msg) {
    const el = $("#formError");
    el.textContent = msg;
    el.hidden = false;
  }

  $("#entryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!session) { closeModal($("#composer")); return openAuth(); }
    const btn = $("#saveBtn");
    btn.disabled = true;
    btn.textContent = "收藏中…";
    try {
      const title = $("#fTitle").value.trim();
      const { data: rows, error } = await cloud.database
        .from("diary_entries")
        .insert({ entry_date: $("#fDate").value, mood: composerMood, title, content: $("#fContent").value.trim() })
        .select();
      if (error) throw error;
      const entry = rows[0];

      for (const f of pendingFiles) {
        const path = cloud.storage.userPath(session.user.id, `diary/${entry.id}/${crypto.randomUUID()}`);
        const up = await cloud.storage.upload(path, f, { contentType: f.type });
        if (up.error) throw up.error;
        const { error: mErr } = await cloud.database.from("diary_media").insert({
          entry_id: entry.id,
          media_type: /^video\//.test(f.type) ? "video" : "image",
          storage_path: path,
          caption: title,
        });
        if (mErr) throw mErr;
      }

      await loadAndRender();
      closeModal($("#composer"));
      toast("这一天已经收进时光轴了");
      document.querySelector("#timeline").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      console.error(err);
      showError(friendlyError(err, "保存失败了，请重试"));
    } finally {
      btn.disabled = false;
      btn.textContent = "收进时光轴";
    }
  });

  /* ================= 日记详情 / 删除 / 分享 ================= */
  document.addEventListener("click", (e) => {
    const readBtn = e.target.closest("[data-read]");
    if (readBtn) openReader(Number(readBtn.dataset.read));
    const sread = e.target.closest("[data-sread]");
    if (sread) openPublicReader(Number(sread.dataset.sread));
    const lb = e.target.closest("[data-lightbox]");
    if (lb) openLightbox(Number(lb.dataset.lightbox));
  });

  function shareLink(e0) {
    return `${location.origin}${location.pathname}#/share/${e0.share_id}`;
  }

  function openReader(id) {
    const e0 = entries.find((x) => x.id === id);
    if (!e0) return;
    $("#readerBody").innerHTML = `
      <div class="reader__date">
        <time>${fmtDate(e0.entry_date)}</time>
        <span class="entry__mood">${MOOD_ICONS[e0.mood] || ""}${MOODS[e0.mood] || "温柔"}</span>
      </div>
      <h3 class="reader__title">${esc(e0.title)}</h3>
      ${e0.media.length ? `<div class="reader__media">${e0.media.filter((m) => !m._broken).map((m) => {
        const src = urlCache.get(m.storage_path) || "";
        return m.media_type === "video"
          ? `<video src="${esc(src)}" controls playsinline preload="metadata"></video>`
          : `<img src="${esc(src)}" alt="${esc(m.caption || "")}" data-lightbox="${m.id}">`;
      }).join("")}</div>` : ""}
      <div class="reader__content">${esc(e0.content)}</div>
      <div class="sharebox">
        <div class="sharebox__row">
          <div>
            <div class="sharebox__label">公开分享这篇日记</div>
            <div class="sharebox__hint">打开后，任何人都能通过链接阅读它；关闭后链接立即失效。</div>
          </div>
          <button class="switch ${e0.is_public ? "is-on" : ""}" id="shareSwitch" role="switch" aria-checked="${e0.is_public}" aria-label="公开分享"></button>
        </div>
        <div class="sharebox__link" id="shareLinkRow" ${e0.is_public ? "" : "hidden"}>
          <span class="sharebox__url" id="shareUrl">${e0.is_public ? esc(shareLink(e0)) : ""}</span>
          <button class="btn btn--ghost" id="copyShare">复制链接</button>
        </div>
      </div>
      <div class="reader__foot">
        <button class="btn btn--danger" id="deleteEntry">删除这篇日记</button>
      </div>`;
    openModal($("#reader"));
    $("#shareSwitch").addEventListener("click", () => toggleShare(e0));
    $("#deleteEntry").addEventListener("click", () => deleteEntry(e0));
    const copyBtn = $("#copyShare");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#shareUrl").textContent);
        toast("链接已复制，去发给想念的人吧");
      } catch {
        toast("复制失败，请手动选中链接复制");
      }
    });
  }

  async function toggleShare(e0) {
    const sw = $("#shareSwitch");
    const turningOn = !e0.is_public;
    sw.disabled = true;
    try {
      if (turningOn) {
        const sid = e0.share_id || shareIdGen();
        // 复制媒体到 shared/，让登录的读者也能看到照片视频
        for (const m of e0.media) {
          if (m.shared_path) continue;
          const to = cloud.storage.sharedPath(session.user.id, `shares/${sid}/${m.id}`);
          const cp = await cloud.storage.copy(m.storage_path, to);
          if (cp.error) throw cp.error;
          const { error: uErr } = await cloud.database.from("diary_media").update({ shared_path: to }).eq("id", m.id).select();
          if (uErr) throw uErr;
          m.shared_path = to;
        }
        const { data, error } = await cloud.database.from("diary_entries")
          .update({ is_public: true, share_id: sid, updated_at: new Date().toISOString() })
          .eq("id", e0.id).select();
        if (error) throw error;
        if (!data || data.length === 0) throw new Error("没有权限分享这篇日记");
        e0.is_public = true;
        e0.share_id = sid;
        sw.classList.add("is-on");
        sw.setAttribute("aria-checked", "true");
        $("#shareLinkRow").hidden = false;
        $("#shareUrl").textContent = shareLink(e0);
        toast("已公开，复制链接分享给朋友吧");
      } else {
        const sharedPaths = e0.media.map((m) => m.shared_path).filter(Boolean);
        if (sharedPaths.length) await cloud.storage.remove(sharedPaths);
        await cloud.database.from("diary_media").update({ shared_path: null }).eq("entry_id", e0.id).select();
        e0.media.forEach((m) => { m.shared_path = null; });
        const { data, error } = await cloud.database.from("diary_entries")
          .update({ is_public: false, updated_at: new Date().toISOString() })
          .eq("id", e0.id).select();
        if (error) throw error;
        if (!data || data.length === 0) throw new Error("没有权限修改这篇日记");
        e0.is_public = false;
        sw.classList.remove("is-on");
        sw.setAttribute("aria-checked", "false");
        $("#shareLinkRow").hidden = true;
        toast("已关闭公开，链接已失效");
      }
      renderTimeline();
      loadSquare();
    } catch (err) {
      console.error(err);
      toast(friendlyError(err, "分享设置失败"));
    } finally {
      sw.disabled = false;
    }
  }

  async function deleteEntry(e0) {
    if (!confirm(`确定删除「${e0.title}」吗？\n里面的照片和视频也会一起从云端删除，无法恢复。`)) return;
    try {
      const paths = [];
      e0.media.forEach((m) => {
        if (m.storage_path) paths.push(m.storage_path);
        if (m.shared_path) paths.push(m.shared_path);
      });
      if (paths.length) {
        const rm = await cloud.storage.remove(paths);
        if (rm.error) console.warn("部分文件删除失败", rm.error);
      }
      const { data, error } = await cloud.database.from("diary_entries").delete().eq("id", e0.id).select();
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("没有删除成功——这篇日记可能不属于你");
      entries = entries.filter((x) => x.id !== e0.id);
      renderAll();
      loadSquare();
      closeModal($("#reader"));
      toast("已经删掉了");
    } catch (err) {
      console.error(err);
      toast(friendlyError(err, "删除失败，请重试"));
    }
  }

  /* ================= 灯箱 ================= */
  let lbList = [];
  let lbIndex = 0;

  function flatMedia() {
    const arr = [];
    entries.forEach((e) => e.media.forEach((m) => { if (!m._broken) arr.push({ m, e }); }));
    return arr;
  }
  function openLightbox(mediaId) {
    lbList = flatMedia();
    lbIndex = Math.max(0, lbList.findIndex((x) => x.m.id === mediaId));
    renderLightbox();
    openModal($("#lightbox"));
  }
  function stepLightbox(d) {
    if (!lbList.length) return;
    lbIndex = (lbIndex + d + lbList.length) % lbList.length;
    renderLightbox();
  }
  function renderLightbox() {
    const { m, e } = lbList[lbIndex];
    const src = urlCache.get(m.storage_path) || "";
    $("#lbStage").innerHTML = `
      ${m.media_type === "video"
        ? `<video src="${esc(src)}" controls autoplay playsinline></video>`
        : `<img src="${esc(src)}" alt="${esc(m.caption || "")}">`}
      <figcaption>${esc(m.caption || e.title)} · ${fmtDate(e.entry_date)}</figcaption>`;
    const multi = lbList.length > 1;
    $("#lbPrev").style.display = multi ? "" : "none";
    $("#lbNext").style.display = multi ? "" : "none";
  }
  $("#lbPrev").addEventListener("click", () => stepLightbox(-1));
  $("#lbNext").addEventListener("click", () => stepLightbox(1));

  /* ================= 分享查看页（无需登录） ================= */
  async function renderShareView(sid) {
    $("#appMain").hidden = true;
    $("#shareView").hidden = false;
    $("#shareBody").innerHTML = '<p style="text-align:center;color:var(--ink-faint)">正在翻开这篇日记…</p>';
    document.body.style.overflow = "";
    scrollTo(0, 0);
    try {
      const { data: e0, error } = await cloud.database
        .from("diary_entries")
        .select("*")
        .eq("share_id", sid)
        .eq("is_public", true)
        .maybeSingle();
      if (error) throw error;
      if (!e0) {
        $("#shareBody").innerHTML = `
          <p class="empty__hand" style="text-align:center">这篇日记不可见</p>
          <p style="text-align:center;color:var(--ink-faint)">链接可能已失效，或者作者把它收回了。</p>`;
        return;
      }
      let mediaHTML = "";
      const viewer = await getSessionSafe();
      const { data: author } = await cloud.database.from("profiles").select("*").eq("owner_id", e0.owner_id).maybeSingle();
      const nick = author?.nickname || "拾光旅人";
      let authorAvatarHTML = esc(nick.slice(0, 1));
      if (viewer && author?.avatar_path) {
        try {
          const au = await signOne(author.avatar_path);
          authorAvatarHTML = `<img src="${esc(au)}" alt="">`;
        } catch { /* 用首字 */ }
      }
      const authorbarHTML = `
        <div class="authorbar">
          <span class="scard__avatar">${authorAvatarHTML}</span>
          <div style="min-width:0">
            <div class="scard__nick">${esc(nick)}</div>
            ${author?.bio ? `<div class="authorbar__bio">${esc(author.bio)}</div>` : ""}
          </div>
        </div>`;
      const { data: mRows } = await cloud.database.from("diary_media").select("*").eq("entry_id", e0.id);
      const media = (mRows || []).filter((m) => m.shared_path || (viewer && viewer.user.id === e0.owner_id));
      if (media.length) {
        if (viewer) {
          await warmUrls(media, (m) => m.shared_path || m.storage_path);
          mediaHTML = `<div class="reader__media">${media.filter((m) => !m._broken).map((m) => {
            const src = urlCache.get(m.shared_path || m.storage_path) || "";
            return m.media_type === "video"
              ? `<video src="${esc(src)}" controls playsinline preload="metadata"></video>`
              : `<img src="${esc(src)}" alt="${esc(m.caption || "")}">`;
          }).join("")}</div>`;
        } else {
          mediaHTML = `<div class="shareview__lock">这篇日记里有 ${media.length} 件照片 / 视频<br>登录拾光记后即可查看</div>`;
        }
      }
      $("#shareBody").innerHTML = `
        ${authorbarHTML}
        <div class="reader__date">
          <time>${fmtDate(e0.entry_date)}</time>
          <span class="entry__mood">${MOOD_ICONS[e0.mood] || ""}${MOODS[e0.mood] || "温柔"}</span>
        </div>
        <h3 class="reader__title">${esc(e0.title)}</h3>
        ${mediaHTML}
        <div class="reader__content">${esc(e0.content)}</div>`;
    } catch (err) {
      console.error(err);
      $("#shareBody").innerHTML = `<p class="empty__hand" style="text-align:center">打开失败了</p>
        <p style="text-align:center;color:var(--ink-faint)">${esc(friendlyError(err, "请稍后重试"))}</p>`;
    }
  }

  function route() {
    const m = location.hash.match(/^#\/share\/([A-Za-z0-9]+)$/);
    if (m) {
      renderShareView(m[1]);
    } else {
      $("#shareView").hidden = true;
      $("#appMain").hidden = false;
    }
  }
  addEventListener("hashchange", route);
  $("#shareHome").addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", location.pathname);
    route();
  });

  /* ---------- 心情筛选 ---------- */
  $("#moodFilter").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    moodFilter = chip.dataset.mood;
    $$("#moodFilter .chip").forEach((c) => c.classList.toggle("is-active", c === chip));
    renderTimeline();
  });

  /* ---------- 导航滚动态 ---------- */
  const nav = $("#nav");
  addEventListener("scroll", () => nav.classList.toggle("is-scrolled", scrollY > 30), { passive: true });

  /* ---------- Hero 尘埃粒子 ---------- */
  function initDust() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (matchMedia("(pointer: coarse)").matches) return;
    const canvas = $("#dust");
    const ctx = canvas.getContext("2d");
    let w, h, parts = [];
    const N = 42;
    function resize() {
      w = canvas.width = canvas.offsetWidth * devicePixelRatio;
      h = canvas.height = canvas.offsetHeight * devicePixelRatio;
    }
    function make() {
      return {
        x: Math.random() * w, y: Math.random() * h,
        r: (Math.random() * 1.6 + 0.5) * devicePixelRatio,
        vx: (Math.random() - 0.3) * 0.16 * devicePixelRatio,
        vy: (Math.random() - 0.5) * 0.1 * devicePixelRatio - 0.05 * devicePixelRatio,
        a: Math.random() * 0.5 + 0.15,
        tw: Math.random() * Math.PI * 2,
      };
    }
    resize();
    parts = Array.from({ length: N }, make);
    addEventListener("resize", resize);
    (function loop(t) {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) Object.assign(p, make(), { y: h + 6 });
        const alpha = p.a * (0.6 + 0.4 * Math.sin(t / 900 + p.tw));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 230, 190, ${alpha})`;
        ctx.fill();
      }
      requestAnimationFrame(loop);
    })(0);
  }

  /* ---------- 启动 ---------- */
  (async function init() {
    renderAuthState();
    observeReveals(document.querySelectorAll(".reveal"));
    initDust();
    route();
    session = await getSessionSafe();
    renderAuthState();
    if (session) await Promise.all([loadAndRender(), loadProfile(), loadSquare()]);
  })();

  addEventListener("pagehide", () => objectURLs.forEach((u) => URL.revokeObjectURL(u)));
})();
