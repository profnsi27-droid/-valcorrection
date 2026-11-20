-- À exécuter une fois : réglage du fournisseur IA choisi depuis l'espace professeur
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  provider text, model text, base_url text
);
alter table settings enable row level security;
create policy admin_all on settings for all using (is_admin()) with check (is_admin());
