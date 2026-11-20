-- ⚠ AVANT D'EXÉCUTER : remplacez VOTRE-EMAIL (2 endroits) par l'adresse e-mail du compte professeur.
-- PROFNSI — schéma Supabase (phase 1). À exécuter dans SQL Editor.
-- Prérequis : Authentication > Providers > Email : désactiver "Allow new users to sign up",
-- puis créer UN SEUL utilisateur (VOTRE-EMAIL) depuis le tableau de bord Supabase.

create or replace function is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'VOTRE-EMAIL'
$$;

create table exams (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  level text not null check (level in ('premiere','terminale')),
  duration_min int not null default 120,
  total_points numeric not null default 20,
  instructions text,
  access_code text unique not null,
  status text not null default 'brouillon' check (status in ('brouillon','ouvert','ferme','archive')),
  subject_path text,        -- PDF dans le bucket "subjects"
  solution_path text,       -- corrigé facultatif
  -- [{ "id":"ex1","title":"...","points":5,"allowed":["python","texte","qcm","image","tableau"],"competences":["..."] }]
  exercises jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table submissions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams(id) on delete cascade,
  last_name text not null,
  first_name text not null,
  class_name text not null,
  session_token uuid not null unique default gen_random_uuid(), -- identifiant de session élève
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  locked boolean not null default false,
  -- { "ex1": [ {"type":"python","code":"...","output":"..."}, {"type":"texte","value":"..."} ] }
  answers jsonb not null default '{}',
  status text not null default 'en_cours' check (status in ('en_cours','soumise','corrigee','validee'))
);

create table events (
  id bigint generated always as identity primary key,
  submission_id uuid not null references submissions(id) on delete cascade,
  type text not null,  -- tab_change, fullscreen_exit, focus_lost, reconnect, edit
  detail jsonb,
  at timestamptz not null default now()
);

create table corrections (
  submission_id uuid primary key references submissions(id) on delete cascade,
  result jsonb not null,        -- détail par exercice, erreurs, conseils, compétences
  total numeric not null,       -- note /20 (modifiable par le professeur)
  to_review boolean not null default false,
  status text not null default 'a_valider' check (status in ('a_valider','validee')),
  validated_at timestamptz,
  emailed_at timestamptz,
  email_error text,
  created_at timestamptz not null default now()
);

create table ai_usage (
  id bigint generated always as identity primary key,
  submission_id uuid references submissions(id) on delete set null,
  model text, tokens_in int, tokens_out int,
  at timestamptz not null default now()
);

-- Verrouillage définitif : une copie verrouillée n'accepte plus de changement de réponses.
create or replace function block_locked() returns trigger language plpgsql as $$
begin
  if old.locked and (new.answers is distinct from old.answers
      or new.locked is distinct from old.locked) then
    raise exception 'Copie verrouillée';
  end if;
  return new;
end $$;
create trigger submissions_lock before update on submissions
  for each row when (old.locked) execute function block_locked();

-- Sécurité : seul le professeur lit/écrit via le client. Les élèves passent
-- uniquement par des Edge Functions (service role) avec code d'examen + session_token.
alter table exams enable row level security;
alter table submissions enable row level security;
alter table events enable row level security;
alter table corrections enable row level security;
alter table ai_usage enable row level security;
create policy admin_all on exams for all using (is_admin()) with check (is_admin());
create policy admin_all on submissions for all using (is_admin()) with check (is_admin());
create policy admin_all on events for all using (is_admin()) with check (is_admin());
create policy admin_all on corrections for all using (is_admin()) with check (is_admin());
create policy admin_all on ai_usage for all using (is_admin()) with check (is_admin());

-- Stockage privé : sujets/corrigés et images des élèves
insert into storage.buckets (id, name, public) values
  ('subjects','subjects',false), ('answer-images','answer-images',false)
on conflict do nothing;
create policy admin_storage on storage.objects for all
  using (is_admin() and bucket_id in ('subjects','answer-images'))
  with check (is_admin() and bucket_id in ('subjects','answer-images'));
