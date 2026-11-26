-- F2 account sync: private, record-level replication of one person's recetario.
--
-- Protocol summary (see src/sync/README.md):
--   * One row per (owner, collection, record_id). Rows are never removed: a deletion is a tombstone
--     (deleted = true, data = null) so a stale device cannot recreate a deleted record.
--   * Clients can only read their own rows. Every write goes through sync_push(), which serializes
--     writers per owner, checks revisions, assigns revisions and a gap-free per-owner change_seq.
--   * Photo bytes live in the private `recipe-photos` bucket under `<owner id>/<sha256(photo id)>`.

create table public.sync_state (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  change_seq bigint not null default 0
);

create table public.sync_records (
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  collection text not null check (collection in (
    'recipes', 'categories', 'ingredients', 'ingredient_overrides',
    'shared_ingredients', 'menu', 'photos', 'shopping_items', 'shopping_balances', 'shopping_checked'
  )),
  record_id text not null check (char_length(record_id) between 1 and 512),
  -- Increments by one for every accepted change of this record.
  revision bigint not null check (revision > 0),
  -- change_seq of the first revision. Clients use it to order menu batches the same way everywhere.
  created_seq bigint not null,
  -- Per-owner feed position of the latest change. Devices pull `change_seq > cursor`.
  change_seq bigint not null,
  deleted boolean not null default false,
  data jsonb,
  device_id text check (char_length(device_id) <= 64),
  updated_at timestamptz not null default now(),
  primary key (owner_id, collection, record_id),
  constraint sync_records_tombstone_has_no_data check (
    (deleted and data is null) or (not deleted and jsonb_typeof(data) = 'object')
  ),
  constraint sync_records_small_data check (pg_column_size(data) <= 1048576)
);

create index sync_records_owner_change_seq_idx on public.sync_records (owner_id, change_seq);

alter table public.sync_state enable row level security;
alter table public.sync_records enable row level security;

-- Default privileges of the Supabase `public` schema grant everything to API roles. Start from zero.
revoke all on table public.sync_state from public, anon, authenticated;
revoke all on table public.sync_records from public, anon, authenticated;
grant select on table public.sync_records to authenticated;

create policy "Owners read their sync records" on public.sync_records
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- Serializes one change feed entry as the shape returned to clients.
create function public.sync_row_json(p_row public.sync_records)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'revision', p_row.revision,
    'deleted', p_row.deleted,
    'data', p_row.data,
    'createdSeq', p_row.created_seq,
    'changeSeq', p_row.change_seq,
    'deviceId', p_row.device_id,
    'updatedAt', p_row.updated_at
  )
$$;
revoke all on function public.sync_row_json(public.sync_records) from public, anon, authenticated;

-- Applies a batch of record changes for the calling user.
--
-- p_owner_id is the account the client captured when it queued the batch. It must equal the account of the
-- current session, so a batch queued for one account is never written under another one after a sign-in
-- in a second tab.
--
-- Each change: {collection, id, baseRevision (number|null), deleted (bool), data (object)}.
-- Each result: {collection, id, status, revision, current?} where status is one of
--   ok           applied (or already applied: a retry of the same data is idempotent)
--   conflict     the record changed since baseRevision; `current` holds the server version
--   invalid      the change is malformed
--   missing_blob a photo record was pushed before its bytes were uploaded
-- The whole call is one transaction under a per-owner lock. Deletions always win; an edit of a
-- tombstone is rejected unless the client already saw that tombstone (baseRevision = its revision).
create function public.sync_push(p_owner_id uuid, p_device_id text, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_seq bigint;
  v_change jsonb;
  v_results jsonb := '[]'::jsonb;
  v_collection text;
  v_id text;
  v_deleted boolean;
  v_base bigint;
  v_data jsonb;
  v_row public.sync_records;
  v_new public.sync_records;
begin
  if v_owner is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_owner_id is distinct from v_owner then
    raise exception 'The batch belongs to another account' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 200 then
    raise exception 'Expected at most 200 changes' using errcode = '22023';
  end if;
  if p_device_id is not null and char_length(p_device_id) > 64 then
    raise exception 'Invalid device id' using errcode = '22023';
  end if;

  insert into public.sync_state (owner_id) values (v_owner) on conflict (owner_id) do nothing;
  select change_seq into v_seq from public.sync_state where owner_id = v_owner for update;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_collection := v_change ->> 'collection';
    v_id := v_change ->> 'id';
    v_deleted := coalesce((v_change ->> 'deleted')::boolean, false);
    v_base := nullif(v_change ->> 'baseRevision', '')::bigint;
    v_data := case when jsonb_typeof(v_change -> 'data') = 'object' then v_change -> 'data' end;

    if v_collection is null
       or v_collection not in ('recipes', 'categories', 'ingredients', 'ingredient_overrides',
                               'shared_ingredients', 'menu', 'photos',
                               'shopping_items', 'shopping_balances', 'shopping_checked')
       or v_id is null or char_length(v_id) not between 1 and 512
       or (v_base is not null and v_base < 1)
       or (not v_deleted and (v_data is null
            or pg_column_size(v_data) > 1048576
            or (v_data ->> 'id') is distinct from v_id))
    then
      v_results := v_results || jsonb_build_object(
        'collection', v_collection, 'id', v_id, 'status', 'invalid');
      continue;
    end if;

    select * into v_row from public.sync_records
      where owner_id = v_owner and collection = v_collection and record_id = v_id
      for update;

    if v_deleted then
      if not found then
        -- Nothing was ever synced under this ID. There is nothing to tombstone.
        v_results := v_results || jsonb_build_object(
          'collection', v_collection, 'id', v_id, 'status', 'ok', 'revision', 0);
      elsif v_row.deleted then
        v_results := v_results || jsonb_build_object(
          'collection', v_collection, 'id', v_id, 'status', 'ok', 'revision', v_row.revision);
      else
        v_seq := v_seq + 1;
        update public.sync_records
          set revision = revision + 1, deleted = true, data = null, change_seq = v_seq,
              device_id = p_device_id, updated_at = now()
          where owner_id = v_owner and collection = v_collection and record_id = v_id
          returning * into v_new;
        v_results := v_results || jsonb_build_object(
          'collection', v_collection, 'id', v_id, 'status', 'ok', 'revision', v_new.revision,
          'current', public.sync_row_json(v_new));
      end if;
      continue;
    end if;

    if v_collection = 'photos' and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'recipe-photos'
        and o.name = v_owner::text || '/' || encode(sha256(convert_to(v_id, 'UTF8')), 'hex')
    ) then
      v_results := v_results || jsonb_build_object(
        'collection', v_collection, 'id', v_id, 'status', 'missing_blob');
      continue;
    end if;

    if not found then
      if v_base is not null then
        v_results := v_results || jsonb_build_object(
          'collection', v_collection, 'id', v_id, 'status', 'conflict');
      else
        v_seq := v_seq + 1;
        insert into public.sync_records
          (owner_id, collection, record_id, revision, created_seq, change_seq, deleted, data, device_id)
          values (v_owner, v_collection, v_id, 1, v_seq, v_seq, false, v_data, p_device_id)
          returning * into v_new;
        v_results := v_results || jsonb_build_object(
          'collection', v_collection, 'id', v_id, 'status', 'ok', 'revision', 1,
          'current', public.sync_row_json(v_new));
      end if;
    elsif not v_row.deleted and v_row.data = v_data then
      -- A retry after a lost response, or two devices that made the same edit.
      v_results := v_results || jsonb_build_object(
        'collection', v_collection, 'id', v_id, 'status', 'ok', 'revision', v_row.revision,
        'current', public.sync_row_json(v_row));
    elsif v_base is not distinct from v_row.revision then
      v_seq := v_seq + 1;
      update public.sync_records
        set revision = revision + 1, deleted = false, data = v_data, change_seq = v_seq,
            device_id = p_device_id, updated_at = now()
        where owner_id = v_owner and collection = v_collection and record_id = v_id
        returning * into v_new;
      v_results := v_results || jsonb_build_object(
        'collection', v_collection, 'id', v_id, 'status', 'ok', 'revision', v_new.revision,
        'current', public.sync_row_json(v_new));
    else
      v_results := v_results || jsonb_build_object(
        'collection', v_collection, 'id', v_id, 'status', 'conflict',
        'current', public.sync_row_json(v_row));
    end if;
  end loop;

  update public.sync_state set change_seq = v_seq where owner_id = v_owner;
  return v_results;
end;
$$;

revoke all on function public.sync_push(uuid, text, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, text, jsonb) to authenticated;

-- Private photo storage. Object names are `<owner id>/<sha256 hex of the photo id>`.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-photos', 'recipe-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Owners read their recipe photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'recipe-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Owners upload their recipe photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recipe-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Owners delete their recipe photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'recipe-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Let other signed-in devices hear about changes. Row-level security filters realtime messages.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.sync_records;
  end if;
end $$;
