-- Account sync: revision rules, tombstones, owner isolation and private photo storage.
-- Run locally with `supabase test db` (never against a linked project).
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

insert into auth.users (id, aud, role, email, instance_id)
values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'a@example.test', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'b@example.test', '00000000-0000-0000-0000-000000000000');

create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  set local role authenticated;
end $$;

create function pg_temp.push(p_change jsonb) returns jsonb language sql as $$
  select (public.sync_push(auth.uid(), 'device-1', jsonb_build_array(p_change)) -> 0)
$$;

create function pg_temp.recipe(p_id text, p_name text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'name', p_name, 'ingredients', '[]'::jsonb, 'steps', '[]'::jsonb,
                            'categoryIds', '[]'::jsonb, 'tags', '[]'::jsonb)
$$;

-- Owner A: revisions ------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');

select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', null,
  'data', pg_temp.recipe('r1', 'Sopa')))->>'status', 'ok', 'creating a record is accepted');
select is((select revision from public.sync_records where record_id = 'r1'), 1::bigint, 'a new record starts at revision 1');

select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 1,
  'data', pg_temp.recipe('r1', 'Sopa de tortilla')))->>'revision', '2', 'an edit on the current revision advances it');

select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 1,
  'data', pg_temp.recipe('r1', 'Sopa de fideo')))->>'status', 'conflict', 'an edit on a stale revision conflicts');
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 1,
  'data', pg_temp.recipe('r1', 'Sopa de fideo')))#>>'{current,data,name}', 'Sopa de tortilla', 'a conflict returns the server version');
select is((select revision from public.sync_records where record_id = 'r1'), 2::bigint, 'a conflict leaves the record untouched');

select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 1,
  'data', pg_temp.recipe('r1', 'Sopa de tortilla')))->>'status', 'ok', 'resending identical data after a lost response is idempotent');
select is((select revision from public.sync_records where record_id = 'r1'), 2::bigint, 'an idempotent retry does not add a revision');

select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', null,
  'data', pg_temp.recipe('r1', 'Otra')))->>'status', 'conflict', 'creating an ID that already exists conflicts');

select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'x', 'baseRevision', 4,
  'data', pg_temp.recipe('x', 'Fantasma')))->>'status', 'conflict', 'a base revision for an unknown record conflicts');

-- The change feed is gap-free and increasing -------------------------------------------------
select is((select array_agg(change_seq order by change_seq) from public.sync_records), array[2::bigint], 'one record, latest change position');
select pg_temp.push(jsonb_build_object('collection', 'categories', 'id', 'c1', 'baseRevision', null,
  'data', jsonb_build_object('id', 'c1', 'name', 'Postres', 'kind', 'dish_type')));
select is((select change_seq from public.sync_records where record_id = 'c1'), 3::bigint, 'the owner counter increases for each accepted change');

-- Deletions ----------------------------------------------------------------------------------
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 1, 'deleted', true))->>'status',
  'ok', 'a delete is accepted even from a stale revision');
select ok((select deleted and data is null and revision = 3 from public.sync_records where record_id = 'r1'), 'the record becomes a tombstone with the next revision');
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 2,
  'data', pg_temp.recipe('r1', 'Edición tardía')))->>'status', 'conflict', 'a stale edit cannot revive a tombstone');
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', null,
  'data', pg_temp.recipe('r1', 'Recreada')))->>'status', 'conflict', 'a client that never saw the record cannot recreate it');
select ok(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 1, 'deleted', true))->>'status' = 'ok'
  and (select revision from public.sync_records where record_id = 'r1') = 3, 'deleting twice is idempotent');
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'never', 'baseRevision', null, 'deleted', true))->>'revision',
  '0', 'deleting an unknown record stores nothing');
select is((select count(*) from public.sync_records where record_id = 'never'), 0::bigint, 'no tombstone is created for an unknown record');
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', 3,
  'data', pg_temp.recipe('r1', 'Restaurada')))->>'status', 'ok', 'a client that already saw the tombstone may recreate the ID');

-- Validation ---------------------------------------------------------------------------------
select is(pg_temp.push(jsonb_build_object('collection', 'unknown', 'id', 'r9', 'data', jsonb_build_object('id', 'r9')))->>'status',
  'invalid', 'unknown collections are rejected');
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r9', 'data', pg_temp.recipe('other', 'x')))->>'status',
  'invalid', 'the payload ID must match the record ID');
select is(pg_temp.push(jsonb_build_object('collection', 'photos', 'id', 'p1', 'baseRevision', null,
  'data', jsonb_build_object('id', 'p1', 'mimeType', 'image/png', 'width', 1, 'height', 1)))->>'status',
  'missing_blob', 'photo metadata is rejected until the bytes are uploaded');

insert into storage.objects (bucket_id, name, owner, metadata)
values ('recipe-photos', '00000000-0000-4000-8000-0000000000a1/' || encode(sha256(convert_to('p1', 'UTF8')), 'hex'),
        '00000000-0000-4000-8000-0000000000a1', '{}');
select is(pg_temp.push(jsonb_build_object('collection', 'photos', 'id', 'p1', 'baseRevision', null,
  'data', jsonb_build_object('id', 'p1', 'mimeType', 'image/png', 'width', 1, 'height', 1)))->>'status',
  'ok', 'photo metadata is accepted after the owner uploads the bytes');

select throws_ok($$insert into public.sync_records (collection, record_id, revision, created_seq, change_seq, data)
  values ('recipes', 'direct', 1, 1, 1, '{"id":"direct"}')$$, '42501', null, 'clients cannot insert rows directly');
select throws_ok($$update public.sync_records set data = '{"id":"r1","name":"hack"}' where record_id = 'r1'$$, '42501', null,
  'clients cannot update rows directly');

-- Owner B: isolation -------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b2');
select is((select count(*) from public.sync_records), 0::bigint, 'another owner sees none of A''s records');
select is(pg_temp.push(jsonb_build_object('collection', 'recipes', 'id', 'r1', 'baseRevision', null,
  'data', pg_temp.recipe('r1', 'Receta de B')))->>'revision', '1', 'the same record ID is independent for another owner');
select is((select count(*) from storage.objects where bucket_id = 'recipe-photos'), 0::bigint, 'another owner cannot list A''s photos');
select throws_ok($$insert into storage.objects (bucket_id, name, owner, metadata)
  values ('recipe-photos', '00000000-0000-4000-8000-0000000000a1/intruder', '00000000-0000-4000-8000-0000000000b2', '{}')$$,
  '42501', null, 'another owner cannot upload into A''s photo folder');

-- A batch is bound to the account that queued it ------------------------------------------------
select throws_ok($$select public.sync_push('00000000-0000-4000-8000-0000000000a1', 'd', '[]'::jsonb)$$, '42501', null,
  'a batch captured for another account is refused');
select throws_ok($$select public.sync_push(null, 'd', '[]'::jsonb)$$, '42501', null, 'a batch without an owner is refused');
select is((select count(*) from public.sync_records where record_id = 'r1'), 1::bigint, 'the refused batches wrote nothing');
select lives_ok($$select public.sync_push(auth.uid(), 'd', '[]'::jsonb)$$, 'a batch for the signed-in account is accepted');

-- Signed-out clients ---------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$select public.sync_push('00000000-0000-4000-8000-0000000000a1', 'd', '[]'::jsonb)$$, '42501', null, 'anonymous clients cannot push');
select throws_ok($$select count(*) from public.sync_records$$, '42501', null, 'anonymous clients cannot read records');

select * from finish();
rollback;
