// KOTANI TIME 側：やまびこシフトとの連携用（読み取り＋シフト開始時刻の受け取りのみ）
// 認証は kt_integration.shift_key の合言葉。verify_jwt は false でデプロイする。
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

function serviceKey(): string {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) { const k = JSON.parse(keys)["default"]; if (k) return k; }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("service key is not available");
  return legacy;
}
function apikeyOnlyFetch(key: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) headers.delete("Authorization");
    return fetch(input, { ...init, headers });
  };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const MONTH_RE = /^\d{4}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/;

function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const n = new Date(Date.UTC(y, m, 1));
  const end = `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return { start, end };
}
// 勤務日（朝8時区切り・日本時間）
function businessDate(iso: string) {
  const t = new Date(iso).getTime() + 9 * 3600e3 - 8 * 3600e3;
  return new Date(t).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  try {
    const key = serviceKey();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, key, {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: apikeyOnlyFetch(key) },
    });
    const body = await req.json().catch(() => ({}));
    const { data: integ } = await db.from("kt_integration").select("shift_key").eq("id", 1).single();
    if (!body.key || !integ?.shift_key || body.key !== integ.shift_key) return json({ error: "forbidden" }, 403);

    if (body.action === "staff") {
      const { data, error } = await db.from("kotani_staff").select("id,name,store_name,employment_type,active").order("store_name").order("name");
      if (error) throw error;
      return json({ staff: data });
    }

    if (body.action === "syncStarts") {
      if (!MONTH_RE.test(body.month ?? "")) return json({ error: "bad_month" }, 400);
      const { start, end } = monthRange(body.month);
      const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r: any) =>
        UUID_RE.test(r?.kotani_staff_id ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(r?.work_date ?? "") && r.work_date >= start && r.work_date < end && !isNaN(Date.parse(r?.start_at)))
        .map((r: any) => ({ kotani_staff_id: r.kotani_staff_id, work_date: r.work_date, start_at: r.start_at, store_name: String(r.store_name ?? "").slice(0, 20), updated_at: new Date().toISOString() }));
      const del = await db.from("kt_shift_starts").delete().gte("work_date", start).lt("work_date", end);
      if (del.error) throw del.error;
      if (rows.length) { const ins = await db.from("kt_shift_starts").upsert(rows, { onConflict: "kotani_staff_id,work_date" }); if (ins.error) throw ins.error; }
      return json({ ok: true, count: rows.length });
    }

    if (body.action === "lateness") {
      if (!MONTH_RE.test(body.month ?? "")) return json({ error: "bad_month" }, 400);
      const { start, end } = monthRange(body.month);
      // 打刻は前後に少し広めに取り、勤務日で絞る
      const from = new Date(Date.parse(start + "T08:00:00+09:00")).toISOString();
      const to = new Date(Date.parse(end + "T08:00:00+09:00")).toISOString();
      const [staffQ, evQ, lateQ, leaveQ, setQ] = await Promise.all([
        db.from("kotani_staff").select("id,name,store_name,employment_type,active"),
        db.from("attendance_events").select("kotani_staff_id,event_at").eq("event_type", "clock_in").is("voided_at", null).gte("event_at", from).lt("event_at", to),
        db.from("kt_lateness").select("*").gte("work_date", start).lt("work_date", end),
        db.from("kt_leave_records").select("staff_id,leave_date,leave_type").eq("leave_type", "annual").gte("leave_date", start).lt("leave_date", end),
        db.from("kt_payroll_settings").select("bonus_min_days,bonus_employment_type,bonus_count_annual_leave,bonus_amount").eq("id", 1).maybeSingle(),
      ]);
      for (const q of [staffQ, evQ, lateQ, leaveQ]) if (q.error) throw q.error;
      const days = new Map<string, Set<string>>();
      for (const e of evQ.data ?? []) {
        const d = businessDate(e.event_at); if (d < start || d >= end) continue;
        if (!days.has(e.kotani_staff_id)) days.set(e.kotani_staff_id, new Set()); days.get(e.kotani_staff_id)!.add(d);
      }
      const s = setQ.data ?? { bonus_min_days: 16, bonus_employment_type: "アルバイト", bonus_count_annual_leave: true, bonus_amount: 8000 };
      if (s.bonus_count_annual_leave) for (const l of leaveQ.data ?? []) {
        if (!days.has(l.staff_id)) days.set(l.staff_id, new Set()); days.get(l.staff_id)!.add(l.leave_date);
      }
      const today = businessDate(new Date().toISOString());
      const result = (staffQ.data ?? []).map((st) => {
        const mine = (lateQ.data ?? []).filter((r) => r.kotani_staff_id === st.id);
        return {
          id: st.id, name: st.name, store: st.store_name, type: st.employment_type, active: st.active,
          days: days.get(st.id)?.size ?? 0,
          scheduled: mine.length,
          late: mine.filter((r) => r.is_late).map((r) => ({ date: r.work_date, start: r.start_at, clockIn: r.first_clock_in, minutes: r.late_minutes, store: r.store_name })),
          noPunch: mine.filter((r) => !r.first_clock_in && r.work_date < today).map((r) => r.work_date),
        };
      });
      return json({ staff: result, rule: { minDays: s.bonus_min_days, type: s.bonus_employment_type, amount: s.bonus_amount } });
    }
    // 出勤時刻を過ぎても出勤打刻がないシフト（遅刻アラート用）
    if (body.action === "noClockIn") {
      const from = Date.parse(body.from), to = Date.parse(body.to);
      if (isNaN(from) || isNaN(to) || to - from > 6 * 3600e3) return json({ error: "bad_range" }, 400);
      const { data, error } = await db.from("kt_lateness").select("kotani_staff_id,work_date,start_at,store_name,first_clock_in")
        .gte("start_at", new Date(from).toISOString()).lt("start_at", new Date(to).toISOString()).is("first_clock_in", null);
      if (error) throw error;
      return json({ rows: data ?? [] });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
