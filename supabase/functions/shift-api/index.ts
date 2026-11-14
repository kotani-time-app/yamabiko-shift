// やまびこシフト API（LINEログイン → LIFFのIDトークンで本人確認）
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "2012523700";
const MSG_TOKEN = Deno.env.get("LINE_MESSAGING_TOKEN") ?? "";
const APP_URL = "https://liff.line.me/2012523700-AHlALqP2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, public code: string) { super(code); } }

const MONTH_RE = /^\d{4}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

async function verifyIdToken(idToken: string): Promise<{ sub: string; name: string }> {
  if (!CHANNEL_ID) throw new HttpError(500, "server_not_configured");
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: CHANNEL_ID }),
  });
  if (!r.ok) throw new HttpError(401, "invalid_token");
  const j = await r.json();
  if (!j.sub) throw new HttpError(401, "invalid_token");
  return { sub: String(j.sub), name: String(j.name ?? "") };
}

async function loadSettings() {
  const { data, error } = await sb.from("shift_settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data as { data: Record<string, unknown>; owner_id: string | null; claim_code: string };
}

function deadlineOf(month: string, day: number): Date {
  const [y, m] = month.split("-").map(Number);
  // 対象月の前月 day日 23:59:59 (JST)
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const yy = prev.getUTCFullYear(), mm = prev.getUTCMonth() + 1;
  return new Date(`${yy}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59:59+09:00`);
}

async function publicSettings(s: Awaited<ReturnType<typeof loadSettings>>) {
  const { data: staff } = await sb.from("shift_staff").select("id,nickname,is_manager");
  const nicknames: Record<string, string> = {};
  const managers: string[] = [];
  for (const r of staff ?? []) {
    if (r.nickname) nicknames[r.id] = r.nickname;
    if (r.is_manager) managers.push(r.id);
  }
  return { ...s.data, nicknames, managers, ownerId: s.owner_id };
}

function staffShape(st: any, reqs: any[], admin = false) {
  const months: Record<string, unknown> = {};
  for (const r of reqs) {
    months[r.month] = { ...(r.data ?? {}), submittedAt: r.submitted_at, firstSubmittedAt: r.first_submitted_at };
  }
  const base: Record<string, unknown> = { name: st.name, stores: st.store ? [st.store] : [], defTime: st.def_time, remindMin: st.remind_min ?? null, months };
  if (admin) { base.support = st.support_stores ?? []; base.ktId = st.kt_staff_id ?? null; }   // 店長だけに返す
  return base;
}

function cleanDays(days: unknown) {
  const out: Record<string, string> = {};
  if (!days || typeof days !== "object") return out;
  for (const [k, v] of Object.entries(days as Record<string, unknown>)) {
    const d = Number(k);
    if (!(d >= 1 && d <= 31) || typeof v !== "string") continue;
    if (v === "any" || v === "off") out[String(d)] = v;
    else if (/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(v)) out[String(d)] = v;
  }
  return out;
}

// ---- LINEメッセージ送信（Messaging API） ----
async function linePush(to: string[], text: string): Promise<string> {
  if (!MSG_TOKEN) return "no_token";
  const results: string[] = [];
  for (let i = 0; i < to.length; i += 500) {
    const r = await fetch("https://api.line.me/v2/bot/message/multicast", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MSG_TOKEN}` },
      body: JSON.stringify({ to: to.slice(i, i + 500), messages: [{ type: "text", text }] }),
    });
    results.push(r.ok ? "ok" : `${r.status}:${(await r.text()).slice(0, 200)}`);
  }
  return results.join(",");
}
function jstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function nextMonthJst() {
  const n = jstNow(); const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function upcomingRemindMonth() {
  const n = jstNow(); const add = n.getUTCDate() >= 21 ? 2 : 1;
  const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + add, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function remindText(month: string) {
  return `【やまびこシフト】\n${Number(month.slice(5))}月のシフト希望がまだ提出されていません。\n締切は過ぎましたが、今からでも提出できます（提出後の変更はできません）。\n\nこちらから提出してください👇\n${APP_URL}`;
}
async function runRemind(month: string) {
  const { data: done } = await sb.from("shift_reminders").select("month").eq("month", month).maybeSingle();
  if (done) return { skipped: true };
  if (!MSG_TOKEN) return { error: "no_token" };
  const [{ data: staff }, { data: reqs }] = await Promise.all([
    sb.from("shift_staff").select("id"),
    sb.from("shift_requests").select("staff_id,submitted_at").eq("month", month),
  ]);
  const submitted = new Set((reqs ?? []).filter((r) => r.submitted_at).map((r) => r.staff_id));
  const to = (staff ?? []).map((s) => s.id).filter((id) => !submitted.has(id));
  const result = to.length ? await linePush(to, remindText(month)) : "none";
  await sb.from("shift_reminders").insert({ month, recipients: to, result });
  return { month, count: to.length, result };
}

// ---- 勤怠給料システム（KOTANI TIME）との連携 ----
const KT_STORE: Record<string, string> = { "嬉野": "梅田" };   // シフトアプリの店舗名 → 勤怠の店舗名
async function ktCall(action: string, payload: Record<string, unknown> = {}) {
  const { data } = await sb.from("shift_settings").select("kt_url,kt_key").eq("id", 1).single();
  if (!data?.kt_url || !data?.kt_key) throw new HttpError(503, "kt_not_configured");
  const r = await fetch(data.kt_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, key: data.kt_key, ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, "kt_error");
  return j;
}
// その月の「各スタッフ・各日の最初の開始時刻」を勤怠側へ送る（紐付け済みのスタッフのみ）
async function syncStarts(month: string) {
  const [{ data: sched }, { data: staff }] = await Promise.all([
    sb.from("shift_schedule").select("days").eq("month", month).maybeSingle(),
    sb.from("shift_staff").select("id,kt_staff_id").not("kt_staff_id", "is", null),
  ]);
  const kt = new Map((staff ?? []).map((s) => [s.id, s.kt_staff_id]));
  const rows: unknown[] = [];
  for (const [d, m] of Object.entries((sched?.days ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const [uid, v] of Object.entries(m)) {
      const ktId = kt.get(uid); if (!ktId || !Array.isArray(v) || !v.length) continue;
      const first = [...v].sort((a: any, b: any) => a.s.localeCompare(b.s))[0] as any;
      const [hh, mm] = first.s.split(":").map(Number);
      const date = `${month}-${String(d).padStart(2, "0")}`;
      const start = new Date(Date.parse(`${date}T00:00:00+09:00`) + (hh * 60 + mm) * 60000).toISOString();
      rows.push({ kotani_staff_id: ktId, work_date: date, start_at: start, store_name: KT_STORE[first.store] ?? first.store });
    }
  }
  return await ktCall("syncStarts", { month, rows });
}
// ---- 出勤リマインダーと遅刻アラート（5分ごとに cronTick で実行） ----
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function storeMark(s: string) { return s.includes("嬉野") ? "🔴" : s.includes("京橋") ? "🔵" : s.includes("布施") ? "🟢" : "・"; }
function lab(t: string) { const [h, m] = t.split(":").map(Number); return `${h >= 24 ? "翌" + (h - 24) : h}:${String(m).padStart(2, "0")}`; }
function jstParts(ms: number) { const d = new Date(ms + 9 * 3600e3); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() }; }
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
async function claimAlert(kind: string, staffId: string, ref: string) {
  const { error } = await sb.from("shift_alerts").insert({ kind, staff_id: staffId, ref });
  return !error;   // 既に送っていれば一意制約で失敗する（二重送信防止）
}
async function runReminders(now: number) {
  const { data: staff } = await sb.from("shift_staff").select("id,remind_min").not("remind_min", "is", null);
  if (!staff?.length) return { reminders: 0 };
  const maxMin = Math.max(...staff.map((s) => s.remind_min));
  const months = new Set<string>();
  for (let t = now; t <= now + (maxMin + 60) * 60000; t += 12 * 3600e3) { const p = jstParts(t); months.add(ym(p.y, p.m)); }
  const end = jstParts(now + (maxMin + 60) * 60000); months.add(ym(end.y, end.m));
  const { data: pubs } = await sb.from("shift_published").select("month,days").in("month", [...months]);
  let sent = 0;
  for (const st of staff) {
    for (const pub of pubs ?? []) {
      for (const [d, list] of Object.entries((pub.days ?? {}) as Record<string, any[]>)) {
        const mine = list.filter((x) => x.uid === st.id).sort((a, b) => a.s.localeCompare(b.s));
        if (!mine.length) continue;
        const [hh, mm] = mine[0].s.split(":").map(Number);
        const date = `${pub.month}-${String(d).padStart(2, "0")}`;
        const startMs = Date.parse(`${date}T00:00:00+09:00`) + (hh * 60 + mm) * 60000;
        const notifyAt = startMs - st.remind_min * 60000;
        if (!(notifyAt <= now && notifyAt > now - 10 * 60000 && startMs > now)) continue;
        if (!(await claimAlert("remind", st.id, `${date} ${mine[0].s}`))) continue;
        const p = jstParts(Date.parse(`${date}T12:00:00+09:00`));
        const text = `【やまびこシフト】出勤予定のお知らせ\n${p.m}/${p.d}(${WD[p.wd]})\n` +
          mine.map((x) => `${storeMark(x.store)}${x.store} ${lab(x.s)}〜${lab(x.e)}`).join("\n") +
          `\n\nシフト表はこちら👇\n${APP_URL}`;
        const r = await linePush([st.id], text);
        await sb.from("shift_alerts").update({ result: r }).eq("kind", "remind").eq("staff_id", st.id).eq("ref", `${date} ${mine[0].s}`);
        sent++;
      }
    }
  }
  return { reminders: sent };
}
async function runLateAlerts(now: number) {
  const { data: cfg } = await sb.from("shift_settings").select("kt_url,kt_key,owner_id").eq("id", 1).single();
  if (!cfg?.kt_url) return { late: 0 };
  const { rows } = await ktCall("noClockIn", { from: new Date(now - 20 * 60000).toISOString(), to: new Date(now - 60000).toISOString() });
  if (!rows?.length) return { late: 0 };
  const { data: staff } = await sb.from("shift_staff").select("id,name,nickname,kt_staff_id,is_manager");
  const byKt = new Map((staff ?? []).filter((s) => s.kt_staff_id).map((s) => [s.kt_staff_id, s]));
  const admins = new Set<string>([...(staff ?? []).filter((s) => s.is_manager).map((s) => s.id), ...(cfg.owner_id ? [cfg.owner_id] : [])]);
  const lines: string[] = [];
  for (const r of rows) {
    const st = byKt.get(r.kotani_staff_id); if (!st) continue;
    const startJ = new Date(Date.parse(r.start_at) + 9 * 3600e3).toISOString().slice(11, 16);
    if (!(await claimAlert("late", st.id, `${r.work_date} ${startJ}`))) continue;
    const store = r.store_name === "梅田" ? "嬉野" : r.store_name;
    const res = await linePush([st.id], `【やまびこシフト】${startJ}からの${store}の出勤打刻が、まだ確認できません。\n出勤している場合は、勤怠システムで「出勤」を押してください。`);
    await sb.from("shift_alerts").update({ result: res }).eq("kind", "late").eq("staff_id", st.id).eq("ref", `${r.work_date} ${startJ}`);
    lines.push(`・${st.nickname || st.name}（${storeMark(store)}${store} ${startJ}〜）`);
  }
  if (lines.length && admins.size) await linePush([...admins], `【遅刻アラート】出勤時刻を過ぎても、出勤の打刻がありません\n${lines.join("\n")}`);
  return { late: lines.length };
}

function background(p: Promise<unknown>) {
  const safe = p.catch((e) => console.error("background", e));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(safe); else return safe;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const { action, idToken } = body ?? {};
    // 自動リマインド（毎月21日0時にデータベースの予約処理から呼ばれる）
    if (action === "cronRemind") {
      const s0 = await sb.from("shift_settings").select("cron_key").eq("id", 1).single();
      if (!body.cronKey || body.cronKey !== s0.data?.cron_key) throw new HttpError(403, "forbidden");
      return json(await runRemind(nextMonthJst()));
    }
    if (action === "cronTick") {
      const s0 = await sb.from("shift_settings").select("cron_key").eq("id", 1).single();
      if (!body.cronKey || body.cronKey !== s0.data?.cron_key) throw new HttpError(403, "forbidden");
      if (!MSG_TOKEN) return json({ error: "no_token" });
      const now = Date.now();
      const out: Record<string, unknown> = {};
      try { Object.assign(out, await runReminders(now)); } catch (e) { console.error("reminders", e); out.remindError = true; }
      try { Object.assign(out, await runLateAlerts(now)); } catch (e) { console.error("late", e); out.lateError = true; }
      return json(out);
    }
    if (typeof idToken !== "string" || !idToken) throw new HttpError(401, "no_token");
    const user = await verifyIdToken(idToken);
    const uid = user.sub;

    let settings = await loadSettings();
    const { data: meRow } = await sb.from("shift_staff").select("*").eq("id", uid).maybeSingle();
    const isOwner = settings.owner_id === uid;
    const isAdmin = isOwner || !!meRow?.is_manager;
    const needAdmin = () => { if (!isAdmin) throw new HttpError(403, "forbidden"); };
    const month: string = body.month;
    const needMonth = () => { if (typeof month !== "string" || !MONTH_RE.test(month)) throw new HttpError(400, "bad_month"); };

    switch (action) {
      case "boot": {
        // オーナー登録（初回のみ、合言葉つきURLで開いたとき）
        if (!settings.owner_id && body.claim && body.claim === settings.claim_code) {
          await sb.from("shift_settings").update({ owner_id: uid, updated_at: new Date().toISOString() }).eq("id", 1);
          await sb.from("shift_staff").upsert({ id: uid, name: meRow?.name || user.name }, { onConflict: "id" });
          settings = await loadSettings();
        }
        const owner = settings.owner_id === uid;
        const { data: reqs } = await sb.from("shift_requests").select("*").eq("staff_id", uid);
        const { data: me2 } = await sb.from("shift_staff").select("*").eq("id", uid).maybeSingle();
        return json({
          uid,
          lineName: user.name,
          role: owner ? "owner" : me2?.is_manager ? "manager" : "staff",
          settings: await publicSettings(settings),
          mine: me2 ? staffShape(me2, reqs ?? []) : null,
        });
      }

      case "saveRequest": {
        needMonth();
        const name = String(body.name ?? "").trim().slice(0, 30);
        const store = String(body.store ?? "");
        const stores = (settings.data.stores as string[]) ?? [];
        if (!name) throw new HttpError(400, "no_name");
        if (!stores.includes(store)) throw new HttpError(400, "bad_store");
        const locked = (settings.data.locked as Record<string, boolean>) ?? {};
        if (locked[month]) throw new HttpError(403, "locked");
        const { data: prev } = await sb.from("shift_requests").select("*").eq("staff_id", uid).eq("month", month).maybeSingle();
        const dl = deadlineOf(month, Number(settings.data.deadline ?? 20));
        if (prev?.submitted_at && Date.now() > dl.getTime()) throw new HttpError(403, "past_deadline");
        const defTime = typeof body.defTime === "string" && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(body.defTime) ? body.defTime : null;
        const now = new Date().toISOString();
        const { error: e1 } = await sb.from("shift_staff").upsert(
          { id: uid, name, store, def_time: defTime ?? meRow?.def_time ?? null, updated_at: now }, { onConflict: "id" });
        if (e1) throw e1;
        const data = { days: cleanDays(body.days), note: String(body.note ?? "").slice(0, 400), stores: [store], defTime };
        const { error: e2 } = await sb.from("shift_requests").upsert({
          staff_id: uid, month, data, submitted_at: now, first_submitted_at: prev?.first_submitted_at ?? now,
        }, { onConflict: "staff_id,month" });
        if (e2) throw e2;
        const { data: reqs } = await sb.from("shift_requests").select("*").eq("staff_id", uid);
        const { data: me2 } = await sb.from("shift_staff").select("*").eq("id", uid).single();
        return json({ ok: true, mine: staffShape(me2, reqs ?? []) });
      }

      case "published": {
        needMonth();
        const { data } = await sb.from("shift_published").select("*").eq("month", month).maybeSingle();
        return json({ published: data ? { days: data.days, offs: data.offs, publishedAt: data.published_at } : null, settings: await publicSettings(settings) });
      }

      case "adminData": {
        needAdmin(); needMonth();
        const [{ data: staff }, { data: reqs }, { data: sched }, { data: pub }] = await Promise.all([
          sb.from("shift_staff").select("*"),
          sb.from("shift_requests").select("*").eq("month", month),
          sb.from("shift_schedule").select("*").eq("month", month).maybeSingle(),
          sb.from("shift_published").select("*").eq("month", month).maybeSingle(),
        ]);
        const all = (staff ?? []).map((st) => ({ id: st.id, data: staffShape(st, (reqs ?? []).filter((r) => r.staff_id === st.id), true) }));
        return json({
          all,
          schedule: sched ? { days: sched.days, updatedAt: sched.updated_at } : { days: {} },
          published: pub ? { days: pub.days, offs: pub.offs, publishedAt: pub.published_at } : null,
          settings: await publicSettings(settings),
        });
      }

      case "assign": {
        needAdmin(); needMonth();
        const day = Number(body.day);
        if (!(day >= 1 && day <= 31)) throw new HttpError(400, "bad_day");
        const target = String(body.uid ?? "");
        let val: unknown = body.val ?? null;
        if (val !== null && val !== "off") {
          if (!Array.isArray(val) || val.length > 6) throw new HttpError(400, "bad_val");
          val = val.map((g: any) => {
            if (!g || typeof g.store !== "string" || !TIME_RE.test(g.s) || !TIME_RE.test(g.e)) throw new HttpError(400, "bad_val");
            return { store: g.store.slice(0, 30), s: g.s, e: g.e };
          });
        }
        const { error } = await sb.rpc("shift_set_assign", { p_month: month, p_day: String(day), p_uid: target, p_val: val });
        if (error) throw error;
        background(syncStarts(month));
        return json({ ok: true, updatedAt: new Date().toISOString() });
      }

      case "publish": {
        needAdmin(); needMonth();
        const [{ data: sched }, { data: staff }] = await Promise.all([
          sb.from("shift_schedule").select("*").eq("month", month).maybeSingle(),
          sb.from("shift_staff").select("id,name,nickname"),
        ]);
        const byId = new Map((staff ?? []).map((s) => [s.id, s]));
        const days: Record<string, unknown[]> = {};
        const offs: Record<string, string[]> = {};
        for (const [d, m] of Object.entries((sched?.days ?? {}) as Record<string, Record<string, unknown>>)) {
          const list: any[] = [];
          for (const [id, v] of Object.entries(m)) {
            if (v === "off") { (offs[d] ??= []).push(id); continue; }
            if (!Array.isArray(v)) continue;
            const st = byId.get(id);
            for (const g of v as any[]) list.push({ uid: id, name: st?.nickname || st?.name || "", store: g.store, s: g.s, e: g.e });
          }
          list.sort((a, b) => a.store.localeCompare(b.store, "ja") || a.s.localeCompare(b.s) || a.name.localeCompare(b.name, "ja"));
          if (list.length) days[d] = list;
        }
        const now = new Date().toISOString();
        const { error } = await sb.from("shift_published").upsert({ month, days, offs, published_at: now }, { onConflict: "month" });
        if (error) throw error;
        background(syncStarts(month));
        return json({ ok: true, published: { days, offs, publishedAt: now } });
      }

      case "saveSettings": {
        needAdmin();
        const s = body.settings ?? {};
        const next: Record<string, unknown> = { ...settings.data };
        if (Array.isArray(s.stores)) next.stores = s.stores.map((x: unknown) => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 10);
        if (TIME_RE.test(s.open ?? "")) next.open = s.open;
        if (TIME_RE.test(s.close ?? "")) next.close = s.close;
        if (Number(s.deadline) >= 1 && Number(s.deadline) <= 28) next.deadline = Number(s.deadline);
        if (s.locked && typeof s.locked === "object") {
          const l: Record<string, boolean> = {};
          for (const [k, v] of Object.entries(s.locked)) if (MONTH_RE.test(k) && v) l[k] = true;
          next.locked = l;
        }
        const { error } = await sb.from("shift_settings").update({ data: next, updated_at: new Date().toISOString() }).eq("id", 1);
        if (error) throw error;
        settings = await loadSettings();
        return json({ ok: true, settings: await publicSettings(settings) });
      }

      case "setNickname": {
        needAdmin();
        const nick = String(body.nickname ?? "").trim().slice(0, 6) || null;
        const { error } = await sb.from("shift_staff").update({ nickname: nick }).eq("id", String(body.uid ?? ""));
        if (error) throw error;
        return json({ ok: true, settings: await publicSettings(settings) });
      }

      case "setSupport": {
        needAdmin();
        const valid = (settings.data.stores as string[]) ?? [];
        const list = Array.isArray(body.stores) ? body.stores.map(String).filter((x: string) => valid.includes(x)) : [];
        const { error } = await sb.from("shift_staff").update({ support_stores: [...new Set(list)] }).eq("id", String(body.uid ?? ""));
        if (error) throw error;
        return json({ ok: true });
      }

      case "ktStaff": {
        needAdmin();
        return json(await ktCall("staff"));
      }

      case "setKtLink": {
        needAdmin();
        const ktId = body.ktId ? String(body.ktId) : null;
        if (ktId && !/^[0-9a-f-]{36}$/.test(ktId)) throw new HttpError(400, "bad_id");
        const { error } = await sb.from("shift_staff").update({ kt_staff_id: ktId }).eq("id", String(body.uid ?? ""));
        if (error) throw error;
        const { data: months } = await sb.from("shift_schedule").select("month").order("month", { ascending: false }).limit(3);
        background(Promise.all((months ?? []).map((m) => syncStarts(m.month))));
        return json({ ok: true });
      }

      case "lateness": {
        needAdmin(); needMonth();
        await syncStarts(month);   // 最新のシフトで判定する
        const kt = await ktCall("lateness", { month });
        const { data: staff } = await sb.from("shift_staff").select("id,kt_staff_id");
        const byKt = new Map((staff ?? []).filter((s) => s.kt_staff_id).map((s) => [s.kt_staff_id, s.id]));
        return json({ rule: kt.rule, staff: (kt.staff ?? []).map((k: any) => ({ ...k, uid: byKt.get(k.id) ?? null })) });
      }

      case "setRemind": {
        const min = body.min == null ? null : Number(body.min);
        if (min !== null && ![30, 60, 120, 180, 360, 720, 1440].includes(min)) throw new HttpError(400, "bad_min");
        const { error } = await sb.from("shift_staff").upsert({ id: uid, name: meRow?.name || user.name, remind_min: min }, { onConflict: "id" });
        if (error) throw error;
        return json({ ok: true, remindMin: min });
      }

      case "testRemind": {
        if (!isOwner) throw new HttpError(403, "forbidden");
        const result = await linePush([uid], "【やまびこシフト】テスト送信です。\nこのメッセージが届いていれば、毎月21日0時の自動リマインドが届きます。\n" + APP_URL);
        return json({ ok: result === "ok", result });
      }

      case "reminders": {
        needAdmin();
        const { data } = await sb.from("shift_reminders").select("month,sent_at,recipients,result").order("month", { ascending: false }).limit(6);
        let quota: unknown = null;
        if (MSG_TOKEN) {
          try {
            const h = { Authorization: `Bearer ${MSG_TOKEN}` };
            const [q, c] = await Promise.all([fetch("https://api.line.me/v2/bot/message/quota", { headers: h }).then((r) => r.json()), fetch("https://api.line.me/v2/bot/message/quota/consumption", { headers: h }).then((r) => r.json())]);
            quota = { limit: q.type === "limited" ? q.value : null, used: c.totalUsage ?? null };
          } catch { /* 取得できなくても続ける */ }
        }
        const { count: remindUsers } = await sb.from("shift_staff").select("id", { count: "exact", head: true }).not("remind_min", "is", null);
        return json({ reminders: (data ?? []).map((r) => ({ month: r.month, sentAt: r.sent_at, count: (r.recipients as unknown[]).length, ok: r.result === "ok" || r.result === "none" })), hasToken: !!MSG_TOKEN, next: upcomingRemindMonth(), quota, remindUsers: remindUsers ?? 0 });
      }

      case "setManager": {
        if (!isOwner) throw new HttpError(403, "forbidden");
        const { error } = await sb.from("shift_staff").update({ is_manager: !!body.on }).eq("id", String(body.uid ?? ""));
        if (error) throw error;
        return json({ ok: true, settings: await publicSettings(settings) });
      }

      default:
        throw new HttpError(400, "unknown_action");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code }, e.status);
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
