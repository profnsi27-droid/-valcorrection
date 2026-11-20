# PROFNSI — Phase 1 : fondations sécurisées

## Mise en route (≈ 10 min)
1. Créez un projet Supabase (offre gratuite).
2. **Authentication → Providers → Email** : désactivez « Allow new users to sign up ».
3. **Authentication → Users** : créez l'unique compte `profnsi27@gmail.com`.
4. **SQL Editor** : exécutez `supabase/schema.sql`.
5. Secrets des fonctions :
   `supabase secrets set AI_API_KEY=... ADMIN_EMAIL=profnsi27@gmail.com AI_PROVIDER=anthropic`
   - Claude : clé créée sur console.anthropic.com (modèle par défaut : claude-haiku-5-5, le plus économique)
   - Gemini (quota gratuit permanent, lit le PDF) : `AI_PROVIDER=gemini` + clé Google AI Studio
   - Mistral / Groq / OpenRouter : `AI_PROVIDER=openai AI_BASE_URL=https://api.mistral.ai/v1 AI_MODEL=...`
     (le PDF n'est pas transmis : remplissez « Texte du sujet »). Exécutez aussi `supabase/migrations/002_subject_text.sql`.
6. Déployez : `supabase functions deploy correct`

## Garanties de sécurité
- Un seul professeur : inscriptions fermées + RLS limitée à son e-mail.
- Élèves sans compte : accès uniquement via fonctions serveur (code + jeton de session).
- Clé IA jamais exposée au navigateur.
- Copie verrouillée : plus aucune modification des réponses après soumission.

## Phases 2 à 4 (livrées)
- `supabase/functions/student` : `supabase functions deploy student --no-verify-jwt`
- `supabase/functions/send-result` : PDF + e-mail. Créez un compte gratuit sur resend.com **avec profnsi27@gmail.com**
  (l'expéditeur de test `onboarding@resend.dev` n'envoie qu'à l'adresse du compte), puis :
  `supabase secrets set RESEND_API_KEY=...` et `supabase functions deploy send-result`
- `student/exam.html` : page élèves (renseigner `FN`).
- `admin/index.html` : espace professeur (renseigner `SB_URL` et `SB_ANON`).

## Reste à faire
Cellules image/tableau, Monaco, éditeur visuel d'exercices, duplication d'examen, affichage de la consommation IA.

## Choix du fournisseur IA (depuis l'espace professeur)
Exécutez `supabase/migrations/002_subject_text.sql` puis `003_settings.sql`. Ajoutez la clé de chaque fournisseur que vous voulez utiliser
(la liste déroulante indique « ✓ clé prête » ou « ⚠ clé absente ») :
`supabase secrets set GEMINI_API_KEY=... MISTRAL_API_KEY=... GROQ_API_KEY=... OPENROUTER_API_KEY=... ANTHROPIC_API_KEY=...`
Les clés ne quittent jamais le serveur. Types de cellules disponibles : Python, texte, QCM, image (3 max), tableau.
Images : envoyées à l'IA seulement avec Gemini et Claude, intégrées dans le PDF corrigé.
