// Edge Function "send-result" — PDF corrigé + e-mail (réservée au professeur).
// Secrets : RESEND_API_KEY, ADMIN_EMAIL (VOTRE-EMAIL)
// Déploiement : supabase functions deploy send-result
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
// Les polices PDF standard ne gèrent que le latin-1 (accents français OK) : le reste devient "?"
const san = (s: unknown) => String(s ?? "").replace(/\t/g, "    ").replace(/\r/g, "").replace(/[^\n\x20-\x7E\xA0-\xFF]/g, "?");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function buildPdf(sub: any, exam: any, cor: any) {
  const pdf = await PDFDocument.create();
  const f = await pdf.embedFont(StandardFonts.Helvetica), fb = await pdf.embedFont(StandardFonts.HelveticaBold), fm = await pdf.embedFont(StandardFonts.Courier);
  const W = 595, H = 842, M = 50; let page = pdf.addPage([W, H]), y = H - M;
  const line = (t: string, font = f, size = 10, color = rgb(0, 0, 0)) => {
    if (y < M + size) { page = pdf.addPage([W, H]); y = H - M; }
    page.drawText(t, { x: M, y, size, font, color }); y -= size * 1.4;
  };
  const para = (t: unknown, font = f, size = 10) => {
    for (const raw of san(t).split("\n")) {
      if (font === fm) { for (let i = 0; i < Math.max(raw.length, 1); i += 80) line(raw.slice(i, i + 80), fm, 9); continue; }
      let cur = "";
      for (const w of raw.split(" ")) {
        const next = cur ? cur + " " + w : w;
        if (cur && font.widthOfTextAtSize(next, size) > W - 2 * M) { line(cur, font, size); cur = w; } else cur = next;
      }
      line(cur, font, size);
    }
  };
  const h = (t: string) => { y -= 6; line(san(t), fb, 12, rgb(0.15, 0.3, 0.7)); };

  line("PROFNSI - Evaluation NSI", fb, 18); y -= 4;
  para(`${sub.last_name} ${sub.first_name} - ${sub.class_name}`, fb, 12);
  para(`${exam.title} - ${new Date(sub.submitted_at ?? Date.now()).toLocaleDateString("fr-FR")}`);
  y -= 4; line(`Note finale : ${cor.total} / 20`, fb, 16);

  for (const x of cor.result.exercices ?? []) {
    const ex = (exam.exercises ?? []).find((e: any) => e.id === x.id), a = sub.answers?.[x.id] ?? {};
    h(`${ex?.title ?? x.id} : ${x.points_obtenus} / ${x.points_max}`);
    para("Reponse de l'eleve", fb);
    if (a.code) para(a.code, fm);
    if (a.output) { para("Sortie :", f); para(a.output, fm); }
    if (a.texte) para(a.texte);
    if (a.tableau?.length) para("Tableau :\n" + a.tableau.map((r: string[]) => r.join(" | ")).join("\n"), fm);
    for (const src of a.images ?? []) {
      try {
        const img = await pdf.embedJpg(Uint8Array.from(atob(String(src).split(",")[1]), (c) => c.charCodeAt(0)));
        const w = Math.min(300, img.width), hh = (img.height * w) / img.width;
        if (y < M + hh) { page = pdf.addPage([W, H]); y = H - M; }
        page.drawImage(img, { x: M, y: y - hh, width: w, height: hh }); y -= hh + 8;
      } catch { para("[image non integree]"); }
    }
    if (a.qcm?.length) para("QCM : " + a.qcm.map((i: number) => ex?.qcm_options?.[i] ?? i).join(", "));
    para("Bareme / justification", fb); para(x.justification);
    para("Correction detaillee", fb); para(x.correction);
    if (x.erreurs?.length) { para("Erreurs identifiees", fb); x.erreurs.forEach((e: string) => para("- " + e)); }
    if (x.conseils) { para("Conseils", fb); para(x.conseils); }
  }
  if (cor.result.competences?.length) { h("Bilan des competences"); cor.result.competences.forEach((c: any) => para(`- ${c.nom} : ${c.niveau}`)); }
  if (cor.result.bilan) { h("Bilan"); para(cor.result.bilan); }
  if (cor.result.conseils_progression) { h("Conseils de progression"); para(cor.result.conseils_progression); }
  return await pdf.save();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await asUser.auth.getUser();
  const admin = Deno.env.get("ADMIN_EMAIL")!;
  if (!user || user.email !== admin) return json({ error: "Accès refusé" }, 403);

  const { submission_id, mode } = await req.json();
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sub } = await db.from("submissions").select("*, exams(*), corrections(*)").eq("id", submission_id).single();
  const cor = Array.isArray(sub?.corrections) ? sub.corrections[0] : sub?.corrections;
  if (!sub || !cor) return json({ error: "Copie non corrigée" }, 404);
  if (cor.status !== "validee") return json({ error: "Validez d'abord la note" }, 409);

  const bytes = await buildPdf(sub, sub.exams, cor), b64 = encodeBase64(bytes);
  if (mode === "download") return json({ ok: true, pdf: b64, filename: `${sub.last_name}_${sub.first_name}.pdf` });

  const clean = (s: string) => s.replace(/[\r\n]+/g, " ");
  const who = clean(`${sub.last_name} ${sub.first_name}`);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "PROFNSI <onboarding@resend.dev>", to: [admin],
      subject: `PROFNSI – Copie corrigée – ${who} – ${clean(sub.class_name)} – ${clean(sub.exams.title)}`,
      html: `<p><b>${esc(who)}</b> — ${esc(sub.class_name)}</p><p>Évaluation : ${esc(sub.exams.title)}<br>
        Soumise le : ${new Date(sub.submitted_at).toLocaleString("fr-FR")}<br><b>Note : ${cor.total} / 20</b></p><p>PDF corrigé en pièce jointe.</p>`,
      attachments: [{ filename: `${who.replace(/\s+/g, "_")}.pdf`, content: b64 }],
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    await db.from("corrections").update({ email_error: detail }).eq("submission_id", submission_id);
    return json({ error: "Échec de l'envoi e-mail", detail }, 502);
  }
  await db.from("corrections").update({ emailed_at: new Date().toISOString(), email_error: null }).eq("submission_id", submission_id);
  return json({ ok: true });
});
