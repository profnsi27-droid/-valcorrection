// Edge Function "student" — seul point d'entrée des élèves (aucun compte).
// Déploiement : supabase functions deploy student --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, apikey, authorization" };
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (v: unknown) => String(v ?? "").trim().slice(0, 80);
const GRACE_MS = 2 * 60 * 1000; // marge de 2 min après la fin

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const b = await req.json().catch(() => ({}));

  const payload = async (sub: any, exam: any) => {
    const { data: signed } = exam.subject_path
      ? await db.storage.from("subjects").createSignedUrl(exam.subject_path, 4 * 3600)
      : { data: null };
    return {
      token: sub.session_token, started_at: sub.started_at, answers: sub.answers, locked: sub.locked,
      pdf_url: signed?.signedUrl ?? null,
      exam: { title: exam.title, duration_min: exam.duration_min, instructions: exam.instructions, exercises: exam.exercises },
    };
  };

  // --- Entrée : code d'examen + identité ---
  if (b.action === "join") {
    const ln = clean(b.last_name), fn = clean(b.first_name), cl = clean(b.class_name);
    const code = clean(b.code).toUpperCase();
    if (!ln || !fn || !cl || !code) return json({ error: "Tous les champs sont obligatoires" }, 400);
    const { data: exam } = await db.from("exams").select("*").eq("access_code", code).eq("status", "ouvert").maybeSingle();
    if (!exam) return json({ error: "Code invalide ou examen fermé" }, 403);

    let { data: sub } = await db.from("submissions").select("*").eq("exam_id", exam.id)
      .eq("last_name", ln).eq("first_name", fn).eq("class_name", cl).maybeSingle();
    if (sub) {
      await db.from("events").insert({ submission_id: sub.id, type: "reconnect" });
    } else {
      ({ data: sub } = await db.from("submissions")
        .insert({ exam_id: exam.id, last_name: ln, first_name: fn, class_name: cl }).select().single());
    }
    return json(await payload(sub, exam));
  }

  // --- Actions authentifiées par jeton de session ---
  const { data: sub } = await db.from("submissions").select("*, exams(*)").eq("session_token", String(b.token)).maybeSingle();
  if (!sub) return json({ error: "Session invalide" }, 403);
  const exam = sub.exams;
  const deadline = new Date(sub.started_at).getTime() + exam.duration_min * 60000 + GRACE_MS;

  if (b.action === "resume") {
    await db.from("events").insert({ submission_id: sub.id, type: "reconnect" });
    return json(await payload(sub, exam));
  }
  if (b.action === "event") {
    if (!sub.locked) await db.from("events").insert({ submission_id: sub.id, type: clean(b.type), detail: b.detail ?? null });
    return json({ ok: true });
  }
  if (sub.locked) return json({ error: "Copie déjà rendue" }, 409);

  if (b.action === "save") {
    if (Date.now() > deadline) return json({ error: "Temps écoulé" }, 410);
    await db.from("submissions").update({ answers: b.answers ?? {} }).eq("id", sub.id);
    return json({ ok: true, saved_at: new Date().toISOString() });
  }
  if (b.action === "submit") {
    // Si le temps est dépassé, on garde la dernière sauvegarde plutôt que les nouvelles réponses.
    const answers = Date.now() > deadline ? sub.answers : (b.answers ?? sub.answers);
    await db.from("submissions").update({ answers, locked: true, status: "soumise", submitted_at: new Date().toISOString() }).eq("id", sub.id);
    return json({ ok: true });
  }
  return json({ error: "Action inconnue" }, 400);
});
