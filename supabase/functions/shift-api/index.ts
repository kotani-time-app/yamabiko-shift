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

function staffShape(st: any, reqs: any[]) {
  const months: Record<string, unknown> = {};
  for (const r of reqs) {
    months[r.month] = { ...(r.data ?? {}), submittedAt: r.submitted_at, firstSubmittedAt: r.first_submitted_at };
  }
  return { name: st.name, stores: st.store ? [st.store] : [], defTime: st.def_time, months };
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
        const all = (staff ?? []).map((st) => ({ id: st.id, data: staffShape(st, (reqs ?? []).filter((r) => r.staff_id === st.id)) }));
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

      case "testRemind": {
        if (!isOwner) throw new HttpError(403, "forbidden");
        const result = await linePush([uid], "【やまびこシフト】テスト送信です。\nこのメッセージが届いていれば、毎月21日0時の自動リマインドが届きます。\n" + APP_URL);
        return json({ ok: result === "ok", result });
      }

      case "reminders": {
        needAdmin();
        const { data } = await sb.from("shift_reminders").select("month,sent_at,recipients,result").order("month", { ascending: false }).limit(6);
        return json({ reminders: (data ?? []).map((r) => ({ month: r.month, sentAt: r.sent_at, count: (r.recipients as unknown[]).length, ok: r.result === "ok" || r.result === "none" })), hasToken: !!MSG_TOKEN, next: upcomingRemindMonth() });
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
