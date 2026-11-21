// Edge Function "correct" — correction IA d'une copie (réservée au professeur).
// Secrets : AI_API_KEY, ADMIN_EMAIL (VOTRE-EMAIL), AI_PROVIDER (anthropic|gemini|openai), AI_MODEL (optionnel).
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const KEYS: Record<string, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const DEF: Record<string, string> = { gemini: "gemini-2.5-flash", anthropic: "claude-haiku-5-5", mistral: "mistral-small-latest", groq: "llama-3.3-70b-versatile", openrouter: "meta-llama/llama-3.3-70b-instruct:free" };
const OA: Record<string, string> = { mistral: "https://api.mistral.ai/v1", groq: "https://api.groq.com/openai/v1", openrouter: "https://openrouter.ai/api/v1" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = Deno.env.get("SUPABASE_URL")!;
  // 1) Seul le professeur peut appeler cette fonction
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user || user.email !== Deno.env.get("ADMIN_EMAIL")) return json({ error: "Accès refusé" }, 403);

  const body = await req.json(); const { submission_id } = body;
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Indique au tableau de bord quelles clés sont configurées (sans jamais les exposer)
  if (body.action === "providers") return json({ providers: Object.fromEntries(Object.entries(KEYS).map(([p, k]) => [p, !!Deno.env.get(k)])) });
  const { data: cfg } = await db.from("settings").select("*").eq("id", 1).maybeSingle();

  const { data: sub } = await db.from("submissions").select("*, exams(*)").eq("id", submission_id).single();
  if (!sub) return json({ error: "Copie introuvable" }, 404);
  const exam = sub.exams;

  // 2) Sujet PDF et corrigé facultatif transmis au modèle
  const docs: { label: string; b64: string }[] = [];
  for (const [label, path] of [["SUJET", exam.subject_path], ["CORRIGÉ OFFICIEL (référence, autres solutions valides acceptées)", exam.solution_path]]) {
    if (!path) continue;
    const { data: file } = await db.storage.from("subjects").download(path);
    if (file) {
      docs.push({ label: String(label), b64: encodeBase64(new Uint8Array(await file.arrayBuffer())) });
    }
  }

  // Les images (data URL) sont extraites du JSON pour ne pas gonfler le prompt, puis jointes séparément
  const imgs: { mime: string; b64: string }[] = [];
  const answersForAI = JSON.parse(JSON.stringify(sub.answers ?? {}, (_k, v) =>
    typeof v === "string" && v.startsWith("data:image/") && imgs.length < 8
      ? (imgs.push({ mime: v.slice(5, v.indexOf(";")), b64: v.split(",")[1] }), `[image n°${imgs.length}]`) : v));
  const prompt = `Tu es un correcteur expert du programme officiel de NSI (${exam.level === "premiere" ? "Première" : "Terminale"}).
Corrige la copie ci-dessous selon le barème. Pour le code Python : syntaxe, logique, résultat d'exécution, cas limites.
Accepte toute solution valide même différente du corrigé. Sois bienveillant et pédagogique.
Si tu hésites sur une réponse, mets "a_verifier": true pour l'exercice.
Réponds UNIQUEMENT en JSON : {"exercices":[{"id":"","points_obtenus":0,"points_max":0,"justification":"","correction":"","erreurs":[""],"conseils":"","a_verifier":false}],
"competences":[{"nom":"","niveau":"acquis|en_cours|non_acquis"}],"bilan":"","conseils_progression":""}
Titre : ${exam.title}
Barème (total ${exam.total_points}) : ${JSON.stringify(exam.exercises)}
Consignes : ${exam.instructions ?? ""}
TEXTE DU SUJET : ${exam.subject_text ?? "(voir PDF joint)"}
RÉPONSES DE L'ÉLÈVE : ${JSON.stringify(answersForAI)}`;
  // 3) Appel du modèle (clé uniquement côté serveur). AI_PROVIDER = "anthropic" (défaut) ou "gemini"
  let provider = cfg?.provider || Deno.env.get("AI_PROVIDER") || "gemini"; if (provider === "openai") provider = "mistral";
  const key = (KEYS[provider] ? Deno.env.get(KEYS[provider]) : undefined) ?? Deno.env.get("AI_API_KEY") ?? "";
  const model0 = cfg?.model || Deno.env.get("AI_MODEL") || DEF[provider] || "";
  if (!key) return json({ error: `Clé API absente pour « ${provider} » (secret ${KEYS[provider] ?? "AI_API_KEY"})` }, 400);
  let model: string, text = "", usage = { in: 0, out: 0 };
  if (provider === "gemini") {
    model = model0;
    const parts: unknown[] = docs.flatMap((d) => [{ text: `${d.label} :` }, { inline_data: { mime_type: "application/pdf", data: d.b64 } }]);
    imgs.forEach((i) => parts.push({ inline_data: { mime_type: i.mime, data: i.b64 } }));
    parts.push({ text: prompt });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    });
    if (!r.ok) return json({ error: "Échec IA, réessayez", detail: (await r.text()).slice(0, 300) }, 502);
    const g = await r.json();
    text = g.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    usage = { in: g.usageMetadata?.promptTokenCount ?? 0, out: g.usageMetadata?.candidatesTokenCount ?? 0 };
  } else if (provider in OA) {
    // Compatible Mistral, Groq, OpenRouter… (AI_BASE_URL + AI_MODEL). Le PDF n'est pas transmis : renseignez le texte du sujet.
    model = model0;
    const base = cfg?.base_url || Deno.env.get("AI_BASE_URL") || OA[provider];
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return json({ error: "Échec IA, réessayez", detail: (await r.text()).slice(0, 300) }, 502);
    const g = await r.json();
    text = g.choices?.[0]?.message?.content ?? "";
    usage = { in: g.usage?.prompt_tokens ?? 0, out: g.usage?.completion_tokens ?? 0 };
  } else {
    model = model0;
    const content: unknown[] = docs.flatMap((d) => [
      { type: "text", text: `${d.label} :` },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: d.b64 } },
    ]);
    imgs.forEach((i) => content.push({ type: "image", source: { type: "base64", media_type: i.mime, data: i.b64 } }));
    content.push({ type: "text", text: prompt });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8000, temperature: 0.2, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) return json({ error: "Échec IA (crédits épuisés ou limite atteinte ?), réessayez", detail: (await r.text()).slice(0, 300) }, 502);
    const g = await r.json();
    text = g.content?.find((c: any) => c.type === "text")?.text ?? "";
    usage = { in: g.usage?.input_tokens ?? 0, out: g.usage?.output_tokens ?? 0 };
  }
  let result;
  try { result = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim()); }
  catch { return json({ error: "Réponse IA illisible, relancez la correction" }, 502); }
  if (!Array.isArray(result?.exercices)) return json({ error: "Réponse IA incomplète, relancez la correction" }, 502);

  // 4) Total recalculé côté serveur (plafonné au barème) puis enregistrement
  const total = Math.min(
    Number(exam.total_points),
    result.exercices.reduce((s: number, e: any) => s + Math.min(Number(e.points_obtenus) || 0, Number(e.points_max) || 0), 0),
  );
  const note20 = Math.round((total / Number(exam.total_points)) * 20 * 4) / 4;
  const to_review = result.exercices.some((e: any) => e.a_verifier);

  await db.from("corrections").upsert({ submission_id, result, total: note20, to_review, status: "a_valider" });
  await db.from("submissions").update({ status: "corrigee" }).eq("id", submission_id);
  await db.from("ai_usage").insert({
    submission_id, model, tokens_in: usage.in, tokens_out: usage.out,
  });

  return json({ ok: true, total: note20, to_review });
});
